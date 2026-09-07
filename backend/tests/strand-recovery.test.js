import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import mongoose from "mongoose";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import {
  findStrandedReminders,
  recoverStrandedReminder,
  runStrandRecoveryPass,
} from "../src/services/reminder.service.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000007";
const TASK_PREFIX = "strand-test";

const createFixture = async (task, { overdue = true, attempts = 0 } = {}) => {
  const reminder = await Reminder.create({
    phoneNumber: FIXTURE_PHONE,
    task,
    reminderTime: new Date(
      overdue ? Date.now() - 60_000 : Date.now() + 60 * 60 * 1000,
    ),
    userId: TEST_USER_ID,
  });

  if (attempts > 0) {
    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { deliveryAttempts: attempts } },
    );
  }

  return reminder;
};

const cleanup = async () => {
  for (const state of ["delayed", "completed", "failed", "waiting", "active"]) {
    const jobs = await reminderQueue.getJobs([state]);

    for (const job of jobs) {
      if (
        job &&
        job.data &&
        job.data.task &&
        job.data.task.startsWith(TASK_PREFIX)
      ) {
        await reminderQueue.remove(job.id).catch(() => {});
      }
    }
  }

  await Reminder.deleteMany({ task: { $regex: /^strand-test/ } });
};

const countJobs = async (reminderId) => {
  const jobs = await reminderQueue.getJobs([
    "waiting",
    "delayed",
    "active",
    "completed",
    "failed",
  ]);

  return jobs.filter((job) => job && job.id === reminderId.toString()).length;
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Reminder.init();
  await cleanup();
});

afterEach(cleanup);

after(async () => {
  await cleanup();
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("stranded detection: zero-attempt class", () => {
  it("A: detects and recovers a zero-attempt overdue stranded reminder", async () => {
    const reminder = await createFixture("strand-test zero", { attempts: 0 });

    assert.equal(
      await reminderQueue.getJob(reminder._id.toString()),
      undefined,
      "precondition: no job exists",
    );

    const stranded = await findStrandedReminders();

    assert.equal(
      stranded.some((r) => r._id.toString() === reminder._id.toString()),
      true,
      "zero-attempt overdue reminder is detected",
    );

    await recoverStrandedReminder(reminder._id);

    const job = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(job, "exactly one job created");
    assert.equal(job.id, reminder._id.toString(), "deterministic jobId");
    assert.equal(job.delay, 0, "immediate delivery for an overdue reminder");
    assert.equal((await Reminder.findById(reminder._id).lean()).deliveryAttempts, 0);
  });

  it("B: the existing attempted class still detected and recovered", async () => {
    const reminder = await createFixture("strand-test attempted", { attempts: 2 });

    const stranded = await findStrandedReminders();

    assert.equal(
      stranded.some((r) => r._id.toString() === reminder._id.toString()),
      true,
      "attempted class remains detected",
    );

    await recoverStrandedReminder(reminder._id);

    const job = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(job);
    assert.equal(job.id, reminder._id.toString());
  });

  it("E: refuses recovery inside the stale-safety window", async () => {
    const fresh = await createFixture("strand-test fresh", { attempts: 0 });

    await Reminder.updateOne(
      { _id: fresh._id },
      { $set: { updatedAt: new Date(Date.now() - 30_000) } },
      { timestamps: false },
    );

    const refused = await recoverStrandedReminder(fresh._id, {
      olderThanMs: 60_000,
    });

    assert.equal(refused, null, "inside the window -> not recovered");
    assert.equal(await countJobs(fresh._id), 0);

    const old = await createFixture("strand-test old", { attempts: 0 });

    await Reminder.updateOne(
      { _id: old._id },
      { $set: { updatedAt: new Date(Date.now() - 90_000) } },
      { timestamps: false },
    );

    const recovered = await recoverStrandedReminder(old._id, {
      olderThanMs: 60_000,
    });

    assert.ok(recovered, "beyond the window -> recovered");
    assert.equal(await countJobs(old._id), 1);
  });

  it("F: recovery does nothing for terminal states", async () => {
    for (const status of ["cancelled", "sent", "failed"]) {
      const reminder = await createFixture(`strand-test ${status}`, {
        attempts: status === "failed" ? 3 : 1,
      });

      await Reminder.updateOne(
        { _id: reminder._id },
        {
          $set: {
            status,
            ...(status === "sent" ? { deliveredAt: new Date() } : {}),
          },
        },
      );

      const stranded = await findStrandedReminders();

      assert.equal(
        stranded.some((r) => r._id.toString() === reminder._id.toString()),
        false,
        `${status} reminders are excluded from the scan`,
      );

      const result = await recoverStrandedReminder(reminder._id);

      assert.equal(result.status, status, "state unchanged");
      assert.equal(await countJobs(reminder._id), 0, "no job created");
    }
  });

  it("G: deleted reminders are never recreated or re-scheduled", async () => {
    const reminder = await createFixture("strand-test deleted", { attempts: 0 });

    await Reminder.deleteOne({ _id: reminder._id });

    const result = await recoverStrandedReminder(reminder._id);

    assert.equal(result, null);
    assert.equal(await countJobs(reminder._id), 0);
    assert.equal(await Reminder.findById(reminder._id), null);
  });

  it("H: repeated recovery produces exactly one logical job", async () => {
    const reminder = await createFixture("strand-test repeat", { attempts: 0 });

    await recoverStrandedReminder(reminder._id);
    await recoverStrandedReminder(reminder._id);

    assert.equal(await countJobs(reminder._id), 1);
  });

  it("C: a live waiting/delayed job is never duplicated", async () => {
    const reminder = await createFixture("strand-test live-job", { attempts: 0 });

    await reminderQueue.add(
      "send-reminder",
      {
        reminderId: reminder._id.toString(),
        task: reminder.task,
        phoneNumber: reminder.phoneNumber,
      },
      {
        jobId: reminder._id.toString(),
        delay: 60_000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    const before = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(before);

    await recoverStrandedReminder(reminder._id);

    const after = await reminderQueue.getJob(reminder._id.toString());

    assert.ok(after);
    assert.equal(after.delay, before.delay, "the live job is untouched");
    assert.equal(await countJobs(reminder._id), 1);
  });

  it("I: concurrent recovery converges on exactly one job", async () => {
    const reminder = await createFixture("strand-test concurrent", { attempts: 0 });

    const jobId = reminder._id.toString();
    const originalAdd = reminderQueue.add;

    let reachedResolve;
    let releaseResolve;

    const reached = new Promise((resolve) => {
      reachedResolve = resolve;
    });

    const release = new Promise((resolve) => {
      releaseResolve = resolve;
    });

    let paused = false;

    // Barrier on the queue seam: the first recovery attempt that reaches
    // the add is paused there, so the second attempt also passes its
    // "no job exists" check before either job is created.
    reminderQueue.add = async function (...args) {
      const opts = args[2] || {};

      if (!paused && opts.jobId === jobId) {
        paused = true;
        reachedResolve();
        await release;
      }

      return originalAdd.apply(this, args);
    };

    try {
      const attempts = Promise.all([
        recoverStrandedReminder(reminder._id),
        recoverStrandedReminder(reminder._id),
      ]);

      await reached;

      releaseResolve();

      const results = await attempts;

      assert.equal(results.length, 2);
      assert.equal(await countJobs(reminder._id), 1, "exactly one logical job");

      const job = await reminderQueue.getJob(jobId);

      assert.ok(job);
      assert.equal(job.id, jobId, "deterministic jobId preserved");
    } finally {
      releaseResolve?.();
      reminderQueue.add = originalAdd;
    }
  });
});

describe("strand recovery pass", () => {
  it("recovers all eligible strands and isolates per-reminder errors", async () => {
    const stranded = await createFixture("strand-test pass-a", { attempts: 0 });
    const live = await createFixture("strand-test pass-b", { attempts: 0 });

    await reminderQueue.add(
      "send-reminder",
      {
        reminderId: live._id.toString(),
        task: live.task,
        phoneNumber: live.phoneNumber,
      },
      {
        jobId: live._id.toString(),
        delay: 60_000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    const result = await runStrandRecoveryPass({ olderThanMs: 0 });

    assert.equal(result.detected >= 2, true);
    assert.ok(result.recovered >= 1);

    assert.equal(await countJobs(stranded._id), 1, "stranded reminder recovered");
    assert.equal(await countJobs(live._id), 1, "live job untouched");
  });
});

describe("strand recovery vs active worker", () => {
  it("D: does not create a competing job while a worker owns the reminder", async () => {
    const reminder = await createFixture("strand-test active", { attempts: 0 });
    let child;

    try {
      child = spawn(
        process.execPath,
        ["tests/helpers/crash-worker-child.js"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CRASH_MODE: "send-then-crash",
            CRASH_QUEUE: "reminders",
            CRASH_SEND_LOG: "C:\\Users\\Dell\\AppData\\Local\\Temp\\opencode\\strand-active.log",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      child.stdout.on("data", () => {});
      child.stderr.on("data", (chunk) => process.stderr.write(`[strand-child] ${chunk}`));

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

      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        const state = await reminderQueue.getJobState(reminder._id.toString());

        if (state === "active") break;

        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      assert.equal(
        await reminderQueue.getJobState(reminder._id.toString()),
        "active",
      );

      await recoverStrandedReminder(reminder._id);

      assert.equal(
        await countJobs(reminder._id),
        1,
        "no competing job while active",
      );
    } finally {
      if (child && !child.killed) {
        child.kill("SIGKILL");
      }

      try {
        const { rmSync } = await import("node:fs");
        rmSync("C:\\Users\\Dell\\AppData\\Local\\Temp\\opencode\\strand-active.log", { force: true });
      } catch {
        // ignore
      }
    }
  });
});