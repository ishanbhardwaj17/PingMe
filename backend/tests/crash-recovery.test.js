import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import {
  advanceRecurrence,
  findStrandedReminders,
  recoverStrandedReminder,
} from "../src/services/reminder.service.js";
import { deliverReminder } from "../src/services/reminder-delivery.service.js";

/**
 * Worker-crash lifecycle being verified:
 *
 * BullMQ job available -> worker receives job -> load reminder ->
 * already delivered? (skip send) -> deliverReminder() -> success ->
 * recurring? advanceRecurrence() -> successor scheduling
 *
 * BullMQ owns execution/retries (attempts 3, exponential backoff; defaults
 * per BullMQ 5.78: lockDuration 30000, stalledInterval 30000,
 * maxStalledCount 1), MongoDB owns reminder state, WhatsApp delivery is
 * the external side effect. A worker crash mid-job leaves the job in the
 * active set; once the lock expires, the stalled check moves the job back
 * to waiting and another worker re-processes it.
 *
 * Crashes are simulated with a real child process (tests/helpers/
 * crash-worker-child.js) that is SIGKILLed mid-execution, so the lock
 * genuinely dies with the process.
 *
 * Exactly-once external delivery is NOT guaranteed: if the process dies
 * between Meta accepting the message and MongoDB persisting deliveredAt,
 * the reprocessed job sends again (verified below). Once delivery state is
 * durable, the already-delivered guard prevents re-sends (verified below).
 */

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000004";
const TASK_PREFIX = "crash-test";
const HARNESS_QUEUE = "reminders-crash-harness";
const CRASH_QUEUE = "reminders-crash-phase";
const SEND_LOG = path.join(process.cwd(), "crash-sends.log");

const successResult = (id = "wamid.crash.test") => ({
  messaging_product: "whatsapp",
  messages: [{ id }],
});

let harnessQueue;
let crashQueue;
let normalWorker;
let currentSendFn;

const processJob = async (job) => {
  if (!currentSendFn) {
    throw new Error(
      "test harness: currentSendFn is not set; refusing to fall back to a real WhatsApp send",
    );
  }

  const reminder = await Reminder.findById(job.data.reminderId);

  if (!reminder) return;

  if (reminder.status === "cancelled" || reminder.status === "failed") {
    return;
  }

  if (reminder.deliveredAt) {
    // skip the send only; recurrence still advances (mirrors the worker)
  } else {
    const outcome = await deliverReminder(reminder, job, currentSendFn);

    if (outcome.skipped) return;
  }

  if (reminder.isRecurring) {
    await advanceRecurrence(reminder);
  }
};

const addJob = async (reminder, { delay = 0 } = {}) =>
  harnessQueue.add(
    "send-reminder",
    {
      reminderId: reminder._id.toString(),
      task: reminder.task,
      phoneNumber: reminder.phoneNumber,
    },
    {
      jobId: reminder._id.toString(),
      delay,
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
    },
  );

const createFixture = async (task, { recurring = false } = {}) =>
  Reminder.create({
    phoneNumber: FIXTURE_PHONE,
    task,
    reminderTime: new Date(Date.now() + 60 * 60 * 1000),
    userId: TEST_USER_ID,
    isRecurring: recurring,
    recurrencePattern: recurring ? "daily" : null,
  });

const waitFor = async (fn, timeoutMs = 15_000, intervalMs = 250) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();

    if (value) return value;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("waitFor timed out");
};

const successorsOf = async (parentId) =>
  Reminder.find({ recurrenceParentId: parentId }).lean();

const cleanup = async () => {
  for (const queue of [harnessQueue, crashQueue, reminderQueue]) {
    if (!queue) continue;

    for (const state of ["delayed", "completed", "failed", "waiting", "active"]) {
      const jobs = await queue.getJobs([state]);

      for (const job of jobs) {
        if (
          job &&
          job.data &&
          job.data.task &&
          job.data.task.startsWith(TASK_PREFIX)
        ) {
          await queue.remove(job.id).catch(() => {});
        }
      }
    }
  }

  await Reminder.deleteMany({ task: { $regex: /^crash-test/ } });

  if (fs.existsSync(SEND_LOG)) {
    fs.rmSync(SEND_LOG);
  }
};

const sendCount = (task) => {
  if (!fs.existsSync(SEND_LOG)) return 0;

  return fs
    .readFileSync(SEND_LOG, "utf8")
    .split("\n")
    .filter((line) => line === `SEND ${task}`).length;
};

const spawnCrashChild = async (mode, queueName = CRASH_QUEUE) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["tests/helpers/crash-worker-child.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CRASH_MODE: mode,
          CRASH_QUEUE: queueName,
          CRASH_SEND_LOG: SEND_LOG,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();

      if (stdout.includes("CRASH_CHILD_STARTED")) {
        resolve(child);
      }
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[crash-child] ${chunk}`);
    });

    child.on("error", reject);
    child.on("exit", () => {
      if (!stdout.includes("CRASH_CHILD_STARTED")) {
        reject(new Error("crash child exited before ready"));
      }
    });
  });

const killChild = async (child) => {
  if (child && !child.killed) {
    child.kill("SIGKILL");

    await new Promise((resolve) => {
      child.once("exit", resolve);

      setTimeout(resolve, 3000);
    });
  }
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Reminder.init();

  harnessQueue = new Queue(HARNESS_QUEUE, { connection: redisConnection });
  crashQueue = new Queue(CRASH_QUEUE, { connection: redisConnection });

  await cleanup();

  normalWorker = new Worker(HARNESS_QUEUE, processJob, {
    connection: redisConnection,
  });
});

afterEach(async () => {
  currentSendFn = undefined;
  await cleanup();
});

after(async () => {
  await cleanup();
  await normalWorker?.close().catch(() => {});
  await harnessQueue?.close().catch(() => {});
  await crashQueue?.close().catch(() => {});
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("worker crash recovery", () => {
  it("reprocesses a job crashed BEFORE delivery persistence (documented re-send)", async () => {
    const reminder = await createFixture("crash-test pre-persist");
    let child;
    let recoveryWorker;

    try {
      child = await spawnCrashChild("send-then-crash");

      currentSendFn = async () => {
        fs.appendFileSync(SEND_LOG, `SEND ${reminder.task}\n`);
        return successResult("wamid.crash.pre");
      };

      await crashQueue.add(
        "send-reminder",
        {
          reminderId: reminder._id.toString(),
          task: reminder.task,
          phoneNumber: reminder.phoneNumber,
        },
        {
          jobId: reminder._id.toString(),
          delay: 0,
          attempts: 3,
          backoff: { type: "exponential", delay: 500 },
        },
      );

      await waitFor(async () => {
        const state = await crashQueue.getJobState(reminder._id.toString());

        return state === "active";
      });

      await waitFor(async () => sendCount(reminder.task) === 1, 5000);

      await killChild(child);
      child = null;

      recoveryWorker = new Worker(CRASH_QUEUE, processJob, {
        connection: redisConnection,
        lockDuration: 1000,
        stalledInterval: 500,
      });

      const done = await waitFor(async () => {
        const current = await Reminder.findById(reminder._id).lean();

        return current.status === "sent" ? current : null;
      });

      assert.equal(
        sendCount(reminder.task),
        2,
        "reprocessing re-sends after the crash window (documented limitation)",
      );
      assert.equal(done.deliveryAttempts, 1);
      assert.equal(done.status, "sent");
      assert.ok(done.deliveredAt);
    } finally {
      await killChild(child);
      await recoveryWorker?.close().catch(() => {});
    }
  });

  it("does NOT re-send when delivery state was persisted before the crash", async () => {
    const reminder = await createFixture("crash-test post-persist", {
      recurring: true,
    });
    let child;
    let recoveryWorker;

    try {
      child = await spawnCrashChild("deliver-then-crash");

      currentSendFn = async () => {
        fs.appendFileSync(SEND_LOG, `SEND ${reminder.task}\n`);
        return successResult("wamid.crash.post");
      };

      await crashQueue.add(
        "send-reminder",
        {
          reminderId: reminder._id.toString(),
          task: reminder.task,
          phoneNumber: reminder.phoneNumber,
        },
        {
          jobId: reminder._id.toString(),
          delay: 0,
          attempts: 3,
          backoff: { type: "exponential", delay: 500 },
        },
      );

      await waitFor(async () => {
        const state = await crashQueue.getJobState(reminder._id.toString());

        return state === "active";
      });

      await waitFor(async () => {
        const current = await Reminder.findById(reminder._id).lean();

        return current.status === "sent";
      });

      await killChild(child);
      child = null;

      const sendsBeforeRecovery = sendCount(reminder.task);

      recoveryWorker = new Worker(CRASH_QUEUE, processJob, {
        connection: redisConnection,
        lockDuration: 1000,
        stalledInterval: 500,
      });

      await waitFor(async () => {
        const current = await Reminder.findById(reminder._id).lean();

        return current.recurrenceNextId ? current : null;
      });

      const done = await Reminder.findById(reminder._id).lean();

      assert.equal(
        sendCount(reminder.task),
        sendsBeforeRecovery,
        "already-delivered guard prevented any additional send",
      );
      assert.equal(done.status, "sent");
      assert.equal(done.deliveredMessageId, "wamid.crash.child");
      assert.equal((await successorsOf(reminder._id)).length, 1);
    } finally {
      await killChild(child);
      await recoveryWorker?.close().catch(() => {});
    }
  });

  it("a stale execution converges on the same successor without moving the timestamp", async () => {
    const reminder = await createFixture("crash-test stale", { recurring: true });

    const staleSnapshot = await Reminder.findById(reminder._id).lean();

    const first = await advanceRecurrence(reminder);

    const advancedAtAfterFirst = (
      await Reminder.findById(reminder._id).lean()
    ).recurrenceAdvancedAt;

    try {
      const staleResult = await advanceRecurrence(staleSnapshot);

      assert.equal(
        staleResult._id.toString(),
        first._id.toString(),
        "stale execution reuses the same successor",
      );
      assert.equal((await successorsOf(reminder._id)).length, 1);

      const after = await Reminder.findById(reminder._id).lean();

      assert.equal(
        after.recurrenceAdvancedAt.getTime(),
        advancedAtAfterFirst.getTime(),
        "recurrenceAdvancedAt never moves forward on a stale/duplicate finalize",
      );
    } finally {
      await reminderQueue.remove(first._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: first._id });
    }
  });
});

describe("stranded reminder detection and recovery", () => {
  it("finds reminders stranded mid-delivery", async () => {
    const reminder = await createFixture("crash-test stranded");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { deliveryAttempts: 1, status: "pending" } },
    );

    const stranded = await findStrandedReminders();

    assert.equal(
      stranded.some((r) => r._id.toString() === reminder._id.toString()),
      true,
      "stranded reminder is detected",
    );

    assert.equal(
      (
        await findStrandedReminders({ olderThanMs: 60_000 })
      ).some((r) => r._id.toString() === reminder._id.toString()),
      false,
      "freshly-touched reminders are excluded by the age bound",
    );
  });

  it("recovers a stranded reminder by re-scheduling its job", async () => {
    const reminder = await createFixture("crash-test recover");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { deliveryAttempts: 1, status: "pending" } },
    );

    const recovered = await recoverStrandedReminder(reminder._id);

    assert.equal(recovered._id.toString(), reminder._id.toString());

    const job = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(job, "job re-scheduled on the real queue with the deterministic jobId");
    assert.equal(job.id, reminder._id.toString());

    currentSendFn = async () => successResult("wamid.crash.recover");

    await processJob({
      data: { reminderId: reminder._id.toString() },
      opts: { attempts: 3 },
      attemptsMade: 0,
    });

    const done = await Reminder.findById(reminder._id).lean();

    assert.equal(done.status, "sent");
    assert.equal(done.deliveryAttempts, 2);
  });

  it("recovers a past-due stranded reminder with an immediate job", async () => {
    const reminder = await createFixture("crash-test past-due");

    await Reminder.updateOne(
      { _id: reminder._id },
      {
        $set: {
          deliveryAttempts: 1,
          status: "pending",
          reminderTime: new Date(Date.now() - 60_000),
        },
      },
    );

    await recoverStrandedReminder(reminder._id);

    const job = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(job, "job re-scheduled for the past-due reminder");
    assert.equal(job.delay, 0, "immediate delivery for a past-due reminder");

    currentSendFn = async () => successResult("wamid.crash.past");

    await processJob({
      data: { reminderId: reminder._id.toString() },
      opts: { attempts: 3 },
      attemptsMade: 0,
    });

    assert.equal((await Reminder.findById(reminder._id).lean()).status, "sent");
  });

  it("recovery is a safe no-op for an already-delivered reminder", async () => {
    const reminder = await createFixture("crash-test delivered");

    await Reminder.updateOne(
      { _id: reminder._id },
      {
        $set: {
          status: "sent",
          deliveredAt: new Date(),
          deliveryAttempts: 1,
        },
      },
    );

    const result = await recoverStrandedReminder(reminder._id);

    assert.equal(result._id.toString(), reminder._id.toString());

    const job = await reminderQueue.getJob(reminder._id.toString());

    assert.equal(job, undefined, "no job re-scheduled for a delivered reminder");

    const stored = await Reminder.findById(reminder._id).lean();

    assert.equal(stored.deliveryAttempts, 1, "delivery history preserved");
    assert.equal(stored.status, "sent", "no state regression");
  });

  it("refuses recovery inside the stale-safety window and allows it beyond", async () => {
    const inside = await createFixture("crash-test boundary-inside");

    await Reminder.updateOne(
      { _id: inside._id },
      {
        $set: { deliveryAttempts: 1, status: "pending" },
        $setOnInsert: {},
      },
      { timestamps: false },
    );

    // Just inside the 60s window: updatedAt = now - 30s
    await Reminder.updateOne(
      { _id: inside._id },
      { $set: { updatedAt: new Date(Date.now() - 30_000) } },
      { timestamps: false },
    );

    const refused = await recoverStrandedReminder(inside._id, {
      olderThanMs: 60_000,
    });

    assert.equal(refused, null, "inside the window -> not recoverable");
    assert.equal(
      await reminderQueue.getJob(inside._id.toString()),
      undefined,
      "no job created inside the window",
    );

    const beyond = await createFixture("crash-test boundary-beyond");

    await Reminder.updateOne(
      { _id: beyond._id },
      {
        $set: {
          deliveryAttempts: 1,
          status: "pending",
          updatedAt: new Date(Date.now() - 90_000),
        },
      },
      { timestamps: false },
    );

    const recovered = await recoverStrandedReminder(beyond._id, {
      olderThanMs: 60_000,
    });

    assert.equal(
      recovered._id.toString(),
      beyond._id.toString(),
      "beyond the window -> recoverable",
    );

    const job = await reminderQueue.getJob(beyond._id.toString());

    assert.ok(job, "exactly one job created beyond the window");
    assert.equal(job.id, beyond._id.toString());
  });

  it("does not churn or duplicate an existing valid job", async () => {
    const reminder = await createFixture("crash-test valid-job");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { deliveryAttempts: 1, status: "pending" } },
    );

    await reminderQueue.add(
      "send-reminder",
      {
        reminderId: reminder._id.toString(),
        task: reminder.task,
        phoneNumber: reminder.phoneNumber,
      },
      {
        jobId: reminder._id.toString(),
        delay: 2 * 60_000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    const before = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(before);
    assert.equal(before.delay, 2 * 60_000);

    const result = await recoverStrandedReminder(reminder._id);

    assert.equal(result._id.toString(), reminder._id.toString());

    const after = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(after);
    assert.equal(
      after.delay,
      before.delay,
      "the existing job was not churned or replaced",
    );

    const delayed = await reminderQueue.getDelayed();

    assert.equal(
      delayed.filter((job) => job && job.id === reminder._id.toString()).length,
      1,
      "exactly one job for the reminder",
    );
  });

  it("preserves deliveryAttempts across recovery", async () => {
    const reminder = await createFixture("crash-test attempts");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { deliveryAttempts: 5, status: "pending" } },
    );

    await recoverStrandedReminder(reminder._id);

    const afterRecovery = await Reminder.findById(reminder._id).lean();

    assert.equal(
      afterRecovery.deliveryAttempts,
      5,
      "recovery must not reset the delivery history",
    );

    currentSendFn = async () => successResult("wamid.crash.attempts");

    await processJob({
      data: { reminderId: reminder._id.toString() },
      opts: { attempts: 3 },
      attemptsMade: 0,
    });

    const done = await Reminder.findById(reminder._id).lean();

    assert.equal(done.deliveryAttempts, 6, "attempts continue from the preserved history");
  });

  it("does not create a second job when past-due recovery is repeated", async () => {
    const reminder = await createFixture("crash-test past-due-twice");

    await Reminder.updateOne(
      { _id: reminder._id },
      {
        $set: {
          deliveryAttempts: 1,
          status: "pending",
          reminderTime: new Date(Date.now() - 60_000),
        },
      },
    );

    await recoverStrandedReminder(reminder._id);
    await recoverStrandedReminder(reminder._id);

    const delayed = await reminderQueue.getDelayed();
    const waiting = await reminderQueue.getWaiting();

    const all = [...delayed, ...waiting].filter(
      (job) => job && job.id === reminder._id.toString(),
    );

    assert.equal(all.length, 1, "exactly one job after repeated recovery");
    assert.equal(all[0].delay, 0, "immediate job for the past-due reminder");
  });

  it("does not recover a reminder whose job is actively being processed", async () => {
    const reminder = await createFixture("crash-test active-race");
    let child;

    try {
      // The child listens on the real "reminders" queue so the active job
      // is exactly what recoverStrandedReminder inspects.
      child = await spawnCrashChild("send-then-crash", "reminders");

      await reminderQueue.add(
        "send-reminder",
        {
          reminderId: reminder._id.toString(),
          task: reminder.task,
          phoneNumber: reminder.phoneNumber,
        },
        {
          jobId: reminder._id.toString(),
          delay: 0,
          attempts: 3,
          backoff: { type: "exponential", delay: 500 },
        },
      );

      await waitFor(async () => {
        const state = await reminderQueue.getJobState(reminder._id.toString());

        return state === "active";
      });

      const refused = await recoverStrandedReminder(reminder._id, {
        olderThanMs: 60_000,
      });

      assert.equal(refused, null, "inside the window -> refused while active");

      const result = await recoverStrandedReminder(reminder._id);

      assert.equal(
        result._id.toString(),
        reminder._id.toString(),
        "without a threshold the reminder is returned untouched",
      );

      const job = await reminderQueue.getJob(reminder._id.toString());

      assert.ok(job, "the original active job still exists");
      assert.equal(
        (await reminderQueue.getDelayed()).filter(
          (j) => j && j.id === reminder._id.toString(),
        ).length,
        0,
        "no competing job created while a worker owns the reminder",
      );
    } finally {
      await killChild(child);
    }
  });
});