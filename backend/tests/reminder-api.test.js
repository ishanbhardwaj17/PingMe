import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import app from "../src/app.js";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";

describe("POST /api/reminders", () => {
  let server;
  let baseUrl;

  before(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    server = app.listen(0);

    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await reminderQueue.close().catch(() => {});
    await redisConnection.quit().catch(() => {});
    await mongoose.disconnect();
  });

  it("returns 400 for a past one-shot reminder, persists nothing, and schedules no job", async () => {
    const task = "api past one-shot regression";

    const response = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumber: "+910000000000",
        task,
        reminderTime: new Date(Date.now() - 60_000).toISOString(),
        userId: new mongoose.Types.ObjectId().toString(),
      }),
    });

    assert.equal(response.status, 400);

    const body = await response.json();

    assert.equal(body.success, false);
    assert.match(body.message, /in the past/);

    assert.equal(await Reminder.countDocuments({ task }), 0);

    const delayed = await reminderQueue.getDelayed();

    assert.equal(
      delayed.some((job) => job.data.task === task),
      false,
      "no BullMQ job should exist for the rejected reminder",
    );
  });
});