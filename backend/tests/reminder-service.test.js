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
        (j) => j && j.data && j.data.reminderId === reminder._id.toString(),
      );

      assert.ok(job, "a delayed job should exist for the reminder");
      assert.ok(
        job.delay > 0,
        "the job delay should be positive",
      );
    } finally {
      const delayed = await reminderQueue.getDelayed();
      const job = delayed.find(
        (j) => j && j.data && j.data.reminderId === reminder._id.toString(),
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
      delayed.some((job) => job && job.data && job.data.task === task),
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
        (j) => j && j.data && j.data.reminderId === reminder._id.toString(),
      );

      assert.ok(job, "a delayed job should exist for the recurring reminder");
    } finally {
      const delayed = await reminderQueue.getDelayed();
      const job = delayed.find(
        (j) => j && j.data && j.data.reminderId === reminder._id.toString(),
      );

      await cleanup(reminder._id, job?.id);
    }
  });
});

describe("BullMQ job identity", () => {
  const findJobFor = async (reminderId) => {
    const delayed = await reminderQueue.getDelayed();

    return delayed.find(
      (j) => j && j.data && j.data.reminderId === reminderId.toString(),
    );
  };

  it("uses the Reminder _id as the BullMQ jobId", async () => {
    const reminder = await createReminder({
      phoneNumber: "+910000000000",
      task: "job identity one",
      reminderTime: new Date(Date.now() + 2 * 60_000),
      userId: TEST_USER_ID,
    });

    try {
      const job = await findJobFor(reminder._id);

      assert.ok(job, "a delayed job should exist for the reminder");
      assert.equal(job.id, reminder._id.toString());

      const stored = await reminderQueue.getJob(job.id);

      assert.equal(stored.id, reminder._id.toString());
      assert.equal(stored.data.reminderId, reminder._id.toString());
      assert.ok(stored.delay > 0, "scheduling behavior is preserved");
    } finally {
      const job = await findJobFor(reminder._id);

      await cleanup(reminder._id, job?.id);
    }
  });

  it("does not create a second stored job when the same jobId is added twice", async () => {
    const reminder = await createReminder({
      phoneNumber: "+910000000000",
      task: "job identity duplicate",
      reminderTime: new Date(Date.now() + 2 * 60_000),
      userId: TEST_USER_ID,
    });

    try {
      const jobId = reminder._id.toString();

      const first = await findJobFor(reminder._id);

      assert.equal(first.id, jobId);

      await reminderQueue.add(
        "send-reminder",
        {
          reminderId: jobId,
          task: reminder.task,
          phoneNumber: reminder.phoneNumber,
        },
        { jobId, delay: 5 * 60_000 },
      );

      const delayed = await reminderQueue.getDelayed();

      const matches = delayed.filter((j) => j && j.id === jobId);

      assert.equal(matches.length, 1, "only one stored job for the jobId");

      const stored = await reminderQueue.getJob(jobId);

      assert.ok(
        stored.delay > 60_000 && stored.delay <= 120_000,
        "stored job keeps its original delay and is not replaced",
      );
    } finally {
      const job = await findJobFor(reminder._id);

      await cleanup(reminder._id, job?.id);
    }
  });

  it("assigns distinct jobIds to distinct reminders", async () => {
    const reminderA = await createReminder({
      phoneNumber: "+910000000000",
      task: "job identity distinct a",
      reminderTime: new Date(Date.now() + 2 * 60_000),
      userId: TEST_USER_ID,
    });

    const reminderB = await createReminder({
      phoneNumber: "+910000000000",
      task: "job identity distinct b",
      reminderTime: new Date(Date.now() + 3 * 60_000),
      userId: TEST_USER_ID,
    });

    try {
      const jobA = await findJobFor(reminderA._id);
      const jobB = await findJobFor(reminderB._id);

      assert.ok(jobA && jobB);

      assert.equal(jobA.id, reminderA._id.toString());
      assert.equal(jobB.id, reminderB._id.toString());
      assert.notEqual(jobA.id, jobB.id);
    } finally {
      const jobA = await findJobFor(reminderA._id);
      const jobB = await findJobFor(reminderB._id);

      await cleanup(reminderA._id, jobA?.id);
      await cleanup(reminderB._id, jobB?.id);
    }
  });
});