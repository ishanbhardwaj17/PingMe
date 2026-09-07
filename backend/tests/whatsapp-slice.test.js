import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import { createReminder } from "../src/services/reminder.service.js";
import { deliverReminder } from "../src/services/reminder-delivery.service.js";
import { parseReminderText } from "../src/utils/parser.js";
import { detectRecurrence } from "../src/utils/recurrenceParser.js";
import { findOrCreateUser } from "../src/services/user.service.js";

const HARNESS_QUEUE = "reminders-slice-harness";

let harnessQueue;
let worker;
let currentSendFn;
let sendCount;

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

  if (!reminder.deliveredAt) {
    const outcome = await deliverReminder(reminder, job, currentSendFn);

    if (outcome.skipped) return;
  }
};

const waitFor = async (fn, timeoutMs = 15_000, intervalMs = 250) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();

    if (value) return value;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("waitFor timed out");
};

const cleanup = async () => {
  for (const queue of [harnessQueue, reminderQueue]) {
    if (!queue) continue;

    const jobs = await queue.getJobs([
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    ]);

    for (const job of jobs) {
      if (job && job.data && job.data.task === "call Mom") {
        await queue.remove(job.id).catch(() => {});
      }
    }
  }

  await Reminder.deleteMany({ task: "call Mom" });
  await Reminder.db
    .collection("users")
    .deleteMany({ phoneNumber: "9199998877" });
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Reminder.init();

  harnessQueue = new Queue(HARNESS_QUEUE, { connection: redisConnection });

  await cleanup();

  worker = new Worker(HARNESS_QUEUE, processJob, {
    connection: redisConnection,
  });
});

afterEach(async () => {
  currentSendFn = undefined;
  sendCount = 0;
  await cleanup();
});

after(async () => {
  await cleanup();
  await worker?.close().catch(() => {});
  await harnessQueue?.close().catch(() => {});
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("first WhatsApp vertical slice (post-parse chain)", () => {
  it('"Remind me tomorrow at 8 PM to call Mom" -> one reminder -> one job -> one delivery', async () => {
    const text = "Remind me tomorrow at 8 PM to call Mom";

    const parsed = parseReminderText(text);

    assert.equal(parsed.task, "call Mom");
    assert.equal(new Date(parsed.reminderTime).getHours(), 20);

    const user = await findOrCreateUser("9199998877");
    const recurrencePattern = detectRecurrence(text);

    const reminder = await createReminder({
      phoneNumber: "9199998877",
      task: parsed.task,
      reminderTime: parsed.reminderTime,
      userId: user._id,
      isRecurring: recurrencePattern !== null,
      recurrencePattern,
    });

    assert.equal(reminder.task, "call Mom");
    assert.equal(reminder.status, "pending");

    sendCount = 0;

    currentSendFn = async () => {
      sendCount++;
      return {
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.slice.confirmation" }],
      };
    };

    // The worker-side job for the created reminder is scheduled on the real
    // queue by createReminder; drive it through the harness queue instead so
    // the deterministic test worker processes it.
    await harnessQueue.add(
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

    const done = await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "sent" ? current : null;
    });

    assert.equal(done.task, "call Mom");
    assert.equal(done.status, "sent");
    assert.ok(done.deliveredAt);
    assert.equal(done.deliveryAttempts, 1);

    const job = await harnessQueue.getJob(reminder._id.toString());

    assert.equal(job.id, reminder._id.toString(), "deterministic jobId");

    const jobs = await harnessQueue.getJobs([
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    ]);

    assert.equal(
      jobs.filter((j) => j && j.id === reminder._id.toString()).length,
      1,
      "exactly one logical job",
    );
  });
});