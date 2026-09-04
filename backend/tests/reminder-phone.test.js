import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import app from "../src/app.js";
import User from "../src/models/user.model.js";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import { createReminder } from "../src/services/reminder.service.js";
import { findOrCreateUser } from "../src/services/user.service.js";

const FIXTURE_PREFIX = "9199998810";
const TEST_USER_ID = new mongoose.Types.ObjectId();

const cleanupFixture = async () => {
  await Reminder.deleteMany({ task: { $regex: /^phone-fixture/ } });
  await User.deleteMany({ phoneNumber: { $regex: `^${FIXTURE_PREFIX}` } });
};

const cleanupReminderJob = async (reminderId) => {
  const delayed = await reminderQueue.getDelayed();

  const job = delayed.find((j) => j.data.reminderId === reminderId.toString());

  if (job) {
    await reminderQueue.remove(job.id);
  }
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(cleanupFixture);

after(async () => {
  await cleanupFixture();
  await reminderQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("reminder phone normalization", () => {
  it("stores a canonical digits-only phone on reminders created via the service", async () => {
    const reminder = await createReminder({
      phoneNumber: "+91 9999 88001",
      task: "phone-fixture one",
      reminderTime: new Date(Date.now() + 60 * 60 * 1000),
      userId: TEST_USER_ID,
    });

    try {
      assert.equal(reminder.phoneNumber, "91999988001");

      const stored = await Reminder.findById(reminder._id);

      assert.equal(stored.phoneNumber, "91999988001");
    } finally {
      await cleanupReminderJob(reminder._id);
      await Reminder.deleteOne({ _id: reminder._id });
    }
  });

  it("rejects a reminder without a usable phone number", async () => {
    await assert.rejects(
      createReminder({
        phoneNumber: "",
        task: "phone-fixture missing",
        reminderTime: new Date(Date.now() + 60 * 60 * 1000),
        userId: TEST_USER_ID,
      }),
      /Phone number is required/,
    );
  });
});

describe("phone-based reminder routes", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
  });

  it("resolve the same canonical user for formatted phone variants", async () => {
    const user = await findOrCreateUser("+91 9999 88102");

    const reminders = [
      await createReminder({
        phoneNumber: "91999988102",
        task: "phone-fixture route one",
        reminderTime: new Date(Date.now() + 2 * 60 * 60 * 1000),
        userId: user._id,
      }),
      await createReminder({
        phoneNumber: "+91999988102",
        task: "phone-fixture route two",
        reminderTime: new Date(Date.now() + 3 * 60 * 60 * 1000),
        userId: user._id,
      }),
    ];

    try {
      const variants = [
        "/api/reminders/user/+91999988102",
        "/api/reminders/user/91999988102",
        "/api/reminders/user/%2B91%209999%2088102",
        "/api/reminders/user/(91)%20999988102",
      ];

      const bodies = [];

      for (const variant of variants) {
        const response = await fetch(`${baseUrl}${variant}`);

        assert.equal(response.status, 200);

        bodies.push(await response.text());
      }

      for (const body of bodies) {
        assert.equal(body, bodies[0]);
      }

      const parsed = JSON.parse(bodies[0]);

      assert.equal(parsed.length, 2);
    } finally {
      for (const reminder of reminders) {
        await cleanupReminderJob(reminder._id);
      }

      await Reminder.deleteMany({ _id: { $in: reminders.map((r) => r._id) } });
    }
  });
});