import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import { cancelReminder } from "../src/services/reminder.service.js";
import { deliverReminder } from "../src/services/reminder-delivery.service.js";
import { advanceRecurrence } from "../src/services/reminder.service.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000005";
const TASK_PREFIX = "cancel-test";
const HARNESS_QUEUE = "reminders-cancel-harness";

const successResult = (id = "wamid.cancel.test") => ({
  messaging_product: "whatsapp",
  messages: [{ id }],
});

let harnessQueue;
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

const cleanup = async () => {
  for (const queue of [harnessQueue, reminderQueue]) {
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

  await Reminder.deleteMany({ task: { $regex: /^cancel-test/ } });
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Reminder.init();

  harnessQueue = new Queue(HARNESS_QUEUE, { connection: redisConnection });

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
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("cancelReminder service", () => {
  it("cancels a pending reminder and removes its scheduled job", async () => {
    const reminder = await createFixture("cancel-test basic");

    // The scheduled job lives on the real queue, exactly where
    // cancelReminder removes it.
    await reminderQueue.add(
      "send-reminder",
      {
        reminderId: reminder._id.toString(),
        task: reminder.task,
        phoneNumber: reminder.phoneNumber,
      },
      {
        jobId: reminder._id.toString(),
        delay: 5 * 60_000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    assert.ok(await reminderQueue.getJob(reminder._id.toString()));

    const cancelled = await cancelReminder(reminder._id);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(
      await reminderQueue.getJob(reminder._id.toString()),
      undefined,
      "scheduled job removed",
    );
  });

  it("is an idempotent no-op for an already-cancelled reminder", async () => {
    const reminder = await createFixture("cancel-test twice");

    await cancelReminder(reminder._id);
    const again = await cancelReminder(reminder._id);

    assert.equal(again.status, "cancelled");
    assert.equal(
      (await Reminder.findById(reminder._id).lean()).status,
      "cancelled",
    );
  });

  it("does not cancel a sent reminder (immutable terminal state)", async () => {
    const reminder = await createFixture("cancel-test sent");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { status: "sent", deliveredAt: new Date(), deliveryAttempts: 1 } },
    );

    const result = await cancelReminder(reminder._id);

    assert.equal(result.status, "sent", "no regression to cancelled");
  });

  it("does not cancel a failed reminder (immutable terminal state)", async () => {
    const reminder = await createFixture("cancel-test failed");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { status: "failed", deliveryAttempts: 3, lastError: "boom" } },
    );

    const result = await cancelReminder(reminder._id);

    assert.equal(result.status, "failed", "no resurrection via cancelled");
  });

  it("returns null for a missing reminder", async () => {
    assert.equal(await cancelReminder(new mongoose.Types.ObjectId()), null);
  });
});

describe("cancellation race safety", () => {
  it("worker loaded the reminder, then cancellation wins: no send", async () => {
    const reminder = await createFixture("cancel-test race");
    let calls = 0;

    const staleSnapshot = await Reminder.findById(reminder._id).lean();

    await cancelReminder(reminder._id);

    const outcome = await deliverReminder(
      staleSnapshot,
      { opts: { attempts: 3 }, attemptsMade: 0 },
      async () => {
        calls++;
        return successResult();
      },
    );

    assert.equal(outcome.skipped, true);
    assert.equal(outcome.status, "cancelled");
    assert.equal(calls, 0, "no send after cancellation");
    assert.equal(
      (await Reminder.findById(reminder._id).lean()).deliveryAttempts,
      0,
      "the delivery gate did not consume an attempt",
    );
  });

  it("cancellation during the send never regresses cancelled to sent", async () => {
    const reminder = await createFixture("cancel-test mid-send");

    let cancelledDuringSend = false;

    const sendFn = async () => {
      await Reminder.updateOne(
        { _id: reminder._id },
        { $set: { status: "cancelled" } },
      );
      cancelledDuringSend = true;
      return successResult("wamid.cancel.mid");
    };

    await deliverReminder(
      reminder,
      { opts: { attempts: 3 }, attemptsMade: 0 },
      sendFn,
    );

    assert.equal(cancelledDuringSend, true);

    const stored = await Reminder.findById(reminder._id).lean();

    assert.equal(stored.status, "cancelled", "cancelled is never regressed to sent");
    assert.equal(stored.deliveredAt, null, "delivery state not written");
  });

  it("a cancelled recurring reminder never advances recurrence", async () => {
    const reminder = await createFixture("cancel-test recur", { recurring: true });

    await cancelReminder(reminder._id);

    await addJob(reminder);

    currentSendFn = async () => successResult();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(
      await Reminder.countDocuments({ recurrenceParentId: reminder._id }),
      0,
      "no successor created for a cancelled reminder",
    );
    assert.equal(
      (await Reminder.findById(reminder._id).lean()).recurrenceNextId,
      null,
    );
  });

  it("a failed reminder replay does not send (terminal gate)", async () => {
    const reminder = await createFixture("cancel-test failed-replay");
    let calls = 0;

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { status: "failed", deliveryAttempts: 3, lastError: "boom" } },
    );

    await addJob(reminder);

    currentSendFn = async () => {
      calls++;
      return successResult();
    };

    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(calls, 0, "terminal reminders are never re-sent");
  });
});

describe("cancellation API", () => {
  let server;
  let baseUrl;

  before(async () => {
    const { default: app } = await import("../src/app.js");

    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
  });

  it("POST /api/reminders/:id/cancel cancels a pending reminder", async () => {
    const reminder = await createFixture("cancel-test api");

    const response = await fetch(`${baseUrl}/api/reminders/${reminder._id}/cancel`, {
      method: "POST",
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.success, true);
    assert.equal(body.reminder.status, "cancelled");
  });

  it("returns 404 for a missing reminder", async () => {
    const response = await fetch(
      `${baseUrl}/api/reminders/${new mongoose.Types.ObjectId()}/cancel`,
      { method: "POST" },
    );

    assert.equal(response.status, 404);
  });
});