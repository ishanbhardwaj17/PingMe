import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import { createReminder } from "../src/services/reminder.service.js";
import redisConnection from "../src/config/redis.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();

const cleanup = async (reminderId, jobId) => {
  if (reminderId) {
    await Reminder.deleteOne({ _id: reminderId });
  }

  if (jobId) {
    await reminderQueue.remove(jobId);
  }
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

after(async () => {
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("createReminder scheduling", () => {
  it("schedules a BullMQ job for a future one-shot reminder", async () => {
    const reminderTime = new Date(Date.now() + 2 * 60_000);

    const reminder = await createReminder({
      phoneNumber: "+910000000000",
      task: "test future one-shot",
      reminderTime,
      userId: TEST_USER_ID,
    });

    try {
      assert.equal(reminder.status, "pending");
      assert.equal(reminder.reminderTime.getTime(), reminderTime.getTime());

      const delayed = await reminderQueue.getDelayed();

      const job = delayed.find(
        (j) => j.data.reminderId === reminder._id.toString(),
      );

      assert.ok(job, "a delayed job should exist for the reminder");
      assert.ok(
        job.delay > 0,
        "the job delay should be positive",
      );
    } finally {
      const delayed = await reminderQueue.getDelayed();
      const job = delayed.find(
        (j) => j.data.reminderId === reminder._id.toString(),
      );

      await cleanup(reminder._id, job?.id);
    }
  });

  it("rejects a past one-shot reminder and stores nothing", async () => {
    const task = "test past one-shot";
    const pastTime = new Date(Date.now() - 60_000);

    await assert.rejects(
      createReminder({
        phoneNumber: "+910000000000",
        task,
        reminderTime: pastTime,
        userId: TEST_USER_ID,
      }),
      /in the past/,
    );

    assert.equal(await Reminder.countDocuments({ task }), 0);

    const delayed = await reminderQueue.getDelayed();

    assert.equal(
      delayed.some((job) => job.data.task === task),
      false,
      "no BullMQ job should exist for the rejected reminder",
    );
  });

  it("resolves a past recurring reminder to the future and schedules it", async () => {
    const task = "test recurring resolves future";
    const pastTime = new Date(Date.now() - 5 * 60_000);

    const reminder = await createReminder({
      phoneNumber: "+910000000000",
      task,
      reminderTime: pastTime,
      isRecurring: true,
      recurrencePattern: "daily",
      userId: TEST_USER_ID,
    });

    try {
      assert.ok(
        reminder.reminderTime.getTime() > Date.now(),
        "resolved reminder time should be in the future",
      );

      const expected = new Date(pastTime.getTime() + 24 * 60 * 60 * 1000);

      assert.equal(reminder.reminderTime.getTime(), expected.getTime());

      const delayed = await reminderQueue.getDelayed();

      const job = delayed.find(
        (j) => j.data.reminderId === reminder._id.toString(),
      );

      assert.ok(job, "a delayed job should exist for the recurring reminder");
    } finally {
      const delayed = await reminderQueue.getDelayed();
      const job = delayed.find(
        (j) => j.data.reminderId === reminder._id.toString(),
      );

      await cleanup(reminder._id, job?.id);
    }
  });
});