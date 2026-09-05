import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import { createReminder } from "../src/services/reminder.service.js";
import {
  deliverReminder,
  isPermanentDeliveryError,
} from "../src/services/reminder-delivery.service.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000001";

const transientError = () =>
  Object.assign(new Error("ECONNRESET: socket closed"), { request: {} });

const permanentError = () =>
  Object.assign(new Error("Bad Request: invalid number"), {
    response: { status: 400, data: {} },
  });

const successResult = (id = "wamid.delivery.test.1") => ({
  messaging_product: "whatsapp",
  messages: [{ id }],
});

let worker;
let currentSendFn;
let harnessQueue;

const addJob = async (reminder) => {
  return harnessQueue.add(
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
};

const createFixture = async (task) =>
  Reminder.create({
    phoneNumber: FIXTURE_PHONE,
    task,
    reminderTime: new Date(Date.now() + 60 * 60 * 1000),
    userId: TEST_USER_ID,
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

const reminderById = async (id) => Reminder.findById(id).lean();

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  // Dedicated queue so this file's worker never competes with other test
  // files' workers on the shared "reminders" queue (parallel-file isolation).
  harnessQueue = new Queue("reminders-delivery-harness", {
    connection: redisConnection,
  });

  worker = new Worker(
    "reminders-delivery-harness",
    async (job) => {
      const reminder = await Reminder.findById(job.data.reminderId);

      if (!reminder) return;

      if (!currentSendFn) {
        throw new Error(
          "test harness: currentSendFn is not set; refusing to fall back to a real WhatsApp send",
        );
      }

      await deliverReminder(reminder, job, currentSendFn);
    },
    { connection: redisConnection },
  );
});

after(async () => {
  await worker?.close().catch(() => {});
  await harnessQueue?.close().catch(() => {});
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("deliverReminder", () => {
  it("records a successful delivery", async () => {
    const reminder = await createFixture("del test success");

    currentSendFn = async () => successResult("wamid.delivery.ok");

    try {
      await addJob(reminder);

      const done = await waitFor(async () => {
        const current = await reminderById(reminder._id);

        return current.status === "sent" ? current : null;
      });

      assert.equal(done.deliveryAttempts, 1);
      assert.equal(done.status, "sent");
      assert.ok(done.deliveredAt);
      assert.equal(done.deliveredMessageId, "wamid.delivery.ok");
      assert.equal(done.lastError, null);
    } finally {
      await harnessQueue.remove(reminder._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: reminder._id });
    }
  });

  it("retries a transient failure and succeeds on the second attempt", async () => {
    const reminder = await createFixture("del test retry succeeds");
    let calls = 0;

    currentSendFn = async () => {
      calls++;

      if (calls === 1) throw transientError();

      return successResult("wamid.delivery.retry");
    };

    try {
      await addJob(reminder);

      const done = await waitFor(async () => {
        const current = await reminderById(reminder._id);

        return current.status === "sent" ? current : null;
      });

      assert.equal(calls, 2, "two actual outbound attempts");
      assert.equal(done.deliveryAttempts, 2);
      assert.equal(done.status, "sent");
      assert.equal(done.deliveredMessageId, "wamid.delivery.retry");
      assert.equal(done.lastError, null);
    } finally {
      await harnessQueue.remove(reminder._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: reminder._id });
    }
  });

  it("fails the reminder after three transient failures with no fourth attempt", async () => {
    const reminder = await createFixture("del test all transient");
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      throw transientError();
    };

    try {
      await addJob(reminder);

      const failed = await waitFor(async () => {
        const current = await reminderById(reminder._id);

        return current.status === "failed" ? current : null;
      });

      assert.equal(failed.deliveryAttempts, 3);
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, "ECONNRESET: socket closed");

      const beforeGrace = calls;

      await new Promise((resolve) => setTimeout(resolve, 2000));

      assert.equal(calls, beforeGrace, "no fourth attempt after grace period");
      assert.equal((await reminderById(reminder._id)).deliveryAttempts, 3);
    } finally {
      await harnessQueue.remove(reminder._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: reminder._id });
    }
  });

  it("fails immediately on a permanent error without consuming retries", async () => {
    const reminder = await createFixture("del test permanent");
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      throw permanentError();
    };

    try {
      await addJob(reminder);

      const failed = await waitFor(async () => {
        const current = await reminderById(reminder._id);

        return current.status === "failed" ? current : null;
      });

      assert.equal(calls, 1, "exactly one attempt");
      assert.equal(failed.deliveryAttempts, 1);
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, "Bad Request: invalid number");

      const job = await harnessQueue.getJob(reminder._id.toString());

      assert.equal(job.attemptsMade, 1, "job failed without consuming retries");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      assert.equal(calls, 1, "no retry after grace period");
    } finally {
      await harnessQueue.remove(reminder._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: reminder._id });
    }
  });
});

describe("isPermanentDeliveryError", () => {
  it("classifies HTTP 4xx (except 429) as permanent", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      assert.equal(
        isPermanentDeliveryError(
          Object.assign(new Error("x"), { response: { status } }),
        ),
        true,
      );
    }
  });

  it("classifies network/timeout errors and HTTP 429/5xx as retryable", () => {
    assert.equal(isPermanentDeliveryError(transientError()), false);

    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(
        isPermanentDeliveryError(
          Object.assign(new Error("x"), { response: { status } }),
        ),
        false,
      );
    }
  });
});

describe("scheduling retry configuration", () => {
  it("configures attempts 3 and exponential backoff at the scheduling chokepoint", async () => {
    const reminder = await createReminder({
      phoneNumber: "+910000000000",
      task: "del test config",
      reminderTime: new Date(Date.now() + 2 * 60_000),
      userId: TEST_USER_ID,
    });

    try {
      const job = await reminderQueue.getJob(reminder._id.toString());

      assert.ok(job, "job scheduled with deterministic jobId");
      assert.equal(job.opts.attempts, 3);
      assert.equal(job.opts.backoff.type, "exponential");
      assert.equal(job.opts.backoff.delay, 5000);
      assert.ok(job.delay > 0, "scheduling behavior preserved");
    } finally {
      await harnessQueue.remove(reminder._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: reminder._id });
    }
  });
});