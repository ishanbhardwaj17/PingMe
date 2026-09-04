import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import { advanceRecurrence } from "../src/services/reminder.service.js";
import { deliverReminder } from "../src/services/reminder-delivery.service.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000002";
const TASK_PREFIX = "adv-test";

const cleanup = async () => {
  const delayed = await reminderQueue.getDelayed();

  for (const job of delayed) {
    if (job && job.data && job.data.task && job.data.task.startsWith(TASK_PREFIX)) {
      await reminderQueue.remove(job.id).catch(() => {});
    }
  }

  await Reminder.deleteMany({ task: { $regex: /^adv-test/ } });
};

const makeRecurring = async (task, { pattern, time, anchorDay = null } = {}) =>
  Reminder.create({
    phoneNumber: FIXTURE_PHONE,
    task,
    reminderTime: time,
    isRecurring: true,
    recurrencePattern: pattern,
    recurrenceAnchorDay: anchorDay,
    userId: TEST_USER_ID,
  });

const successorsOf = async (parentId) =>
  Reminder.find({ recurrenceParentId: parentId }).lean();

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  // Ensure the partial unique index on recurrenceParentId exists before the
  // concurrency tests rely on it (autoIndex builds asynchronously).
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

describe("recurrence advancement (recoverable)", () => {
  it("starts a recurring occurrence with no successor", async () => {
    const reminder = await makeRecurring("adv-test init", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    assert.equal(reminder.recurrenceNextId, null);
    assert.equal(reminder.recurrenceAdvancedAt, null);
    assert.equal((await successorsOf(reminder._id)).length, 0);
  });

  it("creates exactly one successor and finalizes the parent", async () => {
    const reminder = await makeRecurring("adv-test single", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const successor = await advanceRecurrence(reminder);

    try {
      const original = await Reminder.findById(reminder._id);

      assert.ok(original.recurrenceAdvancedAt);
      assert.equal(
        original.recurrenceNextId.toString(),
        successor._id.toString(),
      );

      const successors = await successorsOf(reminder._id);

      assert.equal(successors.length, 1);
      assert.equal(successors[0].recurrenceParentId.toString(), reminder._id.toString());
      assert.equal(successors[0].isRecurring, true);
      assert.equal(successors[0].recurrencePattern, "daily");

      const expected = new Date(
        reminder.reminderTime.getTime() + 24 * 60 * 60 * 1000,
      );

      assert.equal(successor.reminderTime.getTime(), expected.getTime());

      const job = await reminderQueue.getJob(successor._id.toString());

      assert.ok(job, "successor job scheduled");
    } finally {
      await reminderQueue.remove(successor._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: successor._id });
    }
  });

  it("reuses the same successor on repeated advancement", async () => {
    const reminder = await makeRecurring("adv-test repeat", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const first = await advanceRecurrence(reminder);
    const second = await advanceRecurrence(reminder);

    try {
      assert.equal(second._id.toString(), first._id.toString());
      assert.equal((await successorsOf(reminder._id)).length, 1);
      assert.equal(
        (await Reminder.findById(reminder._id)).recurrenceNextId.toString(),
        first._id.toString(),
      );
    } finally {
      await reminderQueue.remove(first._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: first._id });
    }
  });

  it("lets exactly one of five concurrent attempts create the successor", async () => {
    const reminder = await makeRecurring("adv-test concurrent", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => advanceRecurrence(reminder)),
    );

    const successorIds = new Set(results.map((r) => r._id.toString()));

    try {
      assert.equal(successorIds.size, 1, "all attempts converge on one successor");

      const successors = await successorsOf(reminder._id);

      assert.equal(successors.length, 1, "exactly one successor document");

      const original = await Reminder.findById(reminder._id);

      assert.ok(original.recurrenceAdvancedAt);
      assert.equal(
        original.recurrenceNextId.toString(),
        successors[0]._id.toString(),
      );

      const job = await reminderQueue.getJob(successors[0]._id.toString());

      assert.ok(job, "successor job scheduled");
    } finally {
      const successors = await successorsOf(reminder._id);

      for (const successor of successors) {
        await reminderQueue.remove(successor._id.toString()).catch(() => {});
        await Reminder.deleteOne({ _id: successor._id });
      }
    }
  });

  it("recovers when successor creation fails partway (orphan reuse + job heal)", async () => {
    const reminder = await makeRecurring("adv-test recovery", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    redisConnection.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    let threw = false;

    try {
      await advanceRecurrence(reminder);
    } catch {
      threw = true;
    }

    assert.equal(threw, true, "advancement fails while Redis is down");

    redisConnection.connect().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const orphan = await successorsOf(reminder._id);

    try {
      assert.equal(orphan.length, 1, "successor document persisted before the failure");

      const recovered = await advanceRecurrence(reminder);

      assert.equal(
        recovered._id.toString(),
        orphan[0]._id.toString(),
        "retry reuses the existing successor",
      );

      const original = await Reminder.findById(reminder._id);

      assert.ok(original.recurrenceAdvancedAt);
      assert.equal(
        original.recurrenceNextId.toString(),
        orphan[0]._id.toString(),
      );

      const job = await reminderQueue.getJob(orphan[0]._id.toString());

      assert.ok(job, "orphaned successor job healed on retry");
      assert.equal((await successorsOf(reminder._id)).length, 1);
    } finally {
      if (orphan.length) {
        await reminderQueue.remove(orphan[0]._id.toString()).catch(() => {});
        await Reminder.deleteOne({ _id: orphan[0]._id });
      }
    }
  });

  it("recovers when recurrenceNextId points to a missing successor", async () => {
    const reminder = await makeRecurring("adv-test missing-next", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const successor = await advanceRecurrence(reminder);

    await Reminder.deleteOne({ _id: successor._id });
    await reminderQueue.remove(successor._id.toString()).catch(() => {});

    const recovered = await advanceRecurrence(reminder);

    try {
      assert.notEqual(recovered._id.toString(), successor._id.toString());
      assert.equal(
        (await Reminder.findById(reminder._id)).recurrenceNextId.toString(),
        recovered._id.toString(),
      );
      assert.equal((await successorsOf(reminder._id)).length, 1);
    } finally {
      await reminderQueue.remove(recovered._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: recovered._id });
    }
  });

  it("does not advance when delivery fails", async () => {
    const reminder = await makeRecurring("adv-test delivery-fail", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const failingSend = async () => {
      throw Object.assign(new Error("ECONNRESET: socket closed"), {
        request: {},
      });
    };

    await assert.rejects(
      deliverReminder(
        reminder,
        { opts: { attempts: 3 }, attemptsMade: 0 },
        failingSend,
      ),
    );

    const stored = await Reminder.findById(reminder._id);

    assert.equal(stored.recurrenceAdvancedAt, null);
    assert.equal(stored.recurrenceNextId, null);
    assert.equal((await successorsOf(reminder._id)).length, 0);
  });

  it("does not send again for an already-delivered reminder", async () => {
    const reminder = await makeRecurring("adv-test delivered", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    reminder.deliveredAt = new Date();
    await reminder.save();

    let calls = 0;

    const sendSpy = async () => {
      calls++;
      return { messaging_product: "whatsapp", messages: [{ id: "wamid.x" }] };
    };

    const outcome = await deliverReminder(
      reminder,
      { opts: { attempts: 3 }, attemptsMade: 0 },
      sendSpy,
    );

    assert.equal(outcome.alreadyDelivered, true);
    assert.equal(calls, 0, "WhatsApp send must not be called again");

    const successor = await advanceRecurrence(reminder);

    try {
      assert.equal((await successorsOf(reminder._id)).length, 1);
      assert.ok((await Reminder.findById(reminder._id)).recurrenceAdvancedAt);
    } finally {
      await reminderQueue.remove(successor._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: successor._id });
    }
  });
});

describe("existing recurrence calculations with advancement", () => {
  it("creates a daily next occurrence one day ahead", async () => {
    const reminder = await makeRecurring("adv-test daily", {
      pattern: "daily",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const next = await advanceRecurrence(reminder);

    try {
      assert.equal(
        next.reminderTime.getTime(),
        reminder.reminderTime.getTime() + 24 * 60 * 60 * 1000,
      );
    } finally {
      await reminderQueue.remove(next._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: next._id });
    }
  });

  it("creates a weekly next occurrence seven days ahead", async () => {
    const reminder = await makeRecurring("adv-test weekly", {
      pattern: "monday",
      time: new Date(Date.now() + 60 * 60 * 1000),
    });

    const next = await advanceRecurrence(reminder);

    try {
      assert.equal(
        next.reminderTime.getTime(),
        reminder.reminderTime.getTime() + 7 * 24 * 60 * 60 * 1000,
      );
    } finally {
      await reminderQueue.remove(next._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: next._id });
    }
  });

  it("clamps a monthly 31st anchor and preserves it on the successor", async () => {
    const reminder = await makeRecurring("adv-test monthly", {
      pattern: "monthly",
      time: new Date("2027-01-31T03:30:00.000Z"),
      anchorDay: 31,
    });

    const next = await advanceRecurrence(reminder);

    try {
      assert.equal(
        next.reminderTime.toISOString(),
        "2027-02-28T03:30:00.000Z",
        "clamped to the last valid day of February",
      );
      assert.equal(next.recurrenceAnchorDay, 31, "anchor preserved");
      assert.equal(next.isRecurring, true);
      assert.equal(next.recurrencePattern, "monthly");
    } finally {
      await reminderQueue.remove(next._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: next._id });
    }
  });
});