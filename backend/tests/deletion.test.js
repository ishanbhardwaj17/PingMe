import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import { deleteReminder, advanceRecurrence } from "../src/services/reminder.service.js";
import { deliverReminder } from "../src/services/reminder-delivery.service.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000006";
const TASK_PREFIX = "delete-test";
const HARNESS_QUEUE = "reminders-deletion-harness";

const successResult = (id = "wamid.delete.test") => ({
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

const addHarnessJob = async (reminderId, task) =>
  harnessQueue.add(
    "send-reminder",
    {
      reminderId: reminderId.toString(),
      task: task ?? "delete-test replay",
      phoneNumber: FIXTURE_PHONE,
    },
    {
      jobId: reminderId.toString(),
      delay: 0,
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

  await Reminder.deleteMany({ task: { $regex: /^delete-test/ } });
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

describe("deleteReminder service", () => {
  it("A: deletes a pending reminder and removes its future job", async () => {
    const reminder = await createFixture("delete-test pending");

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

    const deleted = await deleteReminder(reminder._id);

    assert.equal(deleted._id.toString(), reminder._id.toString());
    assert.equal(await Reminder.findById(reminder._id), null);
    assert.equal(
      await reminderQueue.getJob(reminder._id.toString()),
      undefined,
      "future job removed",
    );
  });

  it("B: deleting a missing reminder returns null with no side effects", async () => {
    const ghost = new mongoose.Types.ObjectId();

    const result = await deleteReminder(ghost);

    assert.equal(result, null);
    assert.equal(
      (await reminderQueue.getDelayed()).filter((j) => j && j.id === ghost.toString()).length,
      0,
    );
  });

  it("C: deletes a sent reminder without touching anything else", async () => {
    const reminder = await createFixture("delete-test sent");
    const other = await createFixture("delete-test other");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { status: "sent", deliveredAt: new Date(), deliveryAttempts: 1 } },
    );

    await deleteReminder(reminder._id);

    assert.equal(await Reminder.findById(reminder._id), null);
    assert.equal((await Reminder.findById(other._id)).status, "pending");
  });

  it("D: deletes a failed reminder with no resurrection possible", async () => {
    const reminder = await createFixture("delete-test failed");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { status: "failed", deliveryAttempts: 3, lastError: "boom" } },
    );

    await deleteReminder(reminder._id);

    assert.equal(await Reminder.findById(reminder._id), null);

    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult();
    };

    await addHarnessJob(reminder._id, "delete-test failed-replay");

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(calls, 0, "no retry can resurrect a deleted reminder");
  });

  it("E: deletes a cancelled reminder and handles its queue state", async () => {
    const reminder = await createFixture("delete-test cancelled");

    await Reminder.updateOne(
      { _id: reminder._id },
      { $set: { status: "cancelled" } },
    );

    await deleteReminder(reminder._id);

    assert.equal(await Reminder.findById(reminder._id), null);

    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult();
    };

    await addHarnessJob(reminder._id, "delete-test cancelled-replay");

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(calls, 0, "worker replay of a deleted reminder is harmless");
  });

  it("O: deleting twice is deterministic (second call returns null)", async () => {
    const reminder = await createFixture("delete-test twice");

    assert.ok(await deleteReminder(reminder._id));
    assert.equal(await deleteReminder(reminder._id), null);
  });

  it("P: concurrent deletion deletes exactly once without side effects", async () => {
    const reminder = await createFixture("delete-test concurrent");
    const other = await createFixture("delete-test concurrent-other");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => deleteReminder(reminder._id)),
    );

    assert.equal(results.filter(Boolean).length, 1, "exactly one caller deleted it");
    assert.equal(await Reminder.findById(reminder._id), null);
    assert.ok(await Reminder.findById(other._id), "unrelated reminder unaffected");
  });
});

describe("deletion races and the worker", () => {
  it("G+N: a deleted reminder's job replay never delivers", async () => {
    const reminder = await createFixture("delete-test replay");

    await deleteReminder(reminder._id);

    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult();
    };

    await addHarnessJob(reminder._id, "delete-test replay-job");

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(calls, 0, "MongoDB deletion is authoritative");

    const job = await harnessQueue.getJob(reminder._id.toString());

    assert.ok(job, "the job reached a terminal state");
    assert.equal(await job.getState(), "completed", "no infinite retry");
  });

  it("F: a job whose reminder never existed completes safely", async () => {
    const ghost = new mongoose.Types.ObjectId();

    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult();
    };

    await addHarnessJob(ghost, "delete-test ghost");

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(calls, 0, "no WhatsApp call for a missing reminder");

    const job = await harnessQueue.getJob(ghost.toString());

    assert.equal(await job.getState(), "completed", "terminal state, no retry loop");
  });

  it("H: worker loaded the reminder, then deletion wins: no send", async () => {
    const reminder = await createFixture("delete-test stale-race");

    const staleSnapshot = await Reminder.findById(reminder._id).lean();

    await deleteReminder(reminder._id);

    let calls = 0;

    const outcome = await deliverReminder(
      staleSnapshot,
      { opts: { attempts: 3 }, attemptsMade: 0 },
      async () => {
        calls++;
        return successResult();
      },
    );

    assert.equal(outcome.skipped, true, "the delivery gate cannot match a deleted document");
    assert.equal(calls, 0, "no send based on a stale document");
  });

  it("I: deletion during the send leaves no state and no successor", async () => {
    const reminder = await createFixture("delete-test mid-send", { recurring: true });

    let deletedDuringSend = false;

    const sendFn = async () => {
      await deleteReminder(reminder._id);
      deletedDuringSend = true;
      return successResult("wamid.delete.mid");
    };

    const outcome = await deliverReminder(
      reminder,
      { opts: { attempts: 3 }, attemptsMade: 0 },
      sendFn,
    );

    assert.equal(deletedDuringSend, true);
    assert.equal(outcome.success, true);
    assert.equal(await Reminder.findById(reminder._id), null, "document deleted");

    await advanceRecurrence(reminder).catch(() => {});

    assert.equal(
      await Reminder.countDocuments({ recurrenceParentId: reminder._id }),
      0,
      "no successor is ever created from a deleted reminder",
    );
  });

  it("M: delete vs advancement race never produces duplicate successors", async () => {
    const parent = await createFixture("delete-test adv-race", { recurring: true });

    await Reminder.updateOne(
      { _id: parent._id },
      { $set: { status: "sent", deliveredAt: new Date(), deliveryAttempts: 1 } },
    );

    const staleSnapshot = await Reminder.findById(parent._id).lean();

    await deleteReminder(parent._id);

    // The stale worker execution still holds the delivered parent and
    // attempts advancement after the deletion.
    await advanceRecurrence(staleSnapshot).catch(() => {});

    const successors = await Reminder.find({
      recurrenceParentId: parent._id,
    }).lean();

    assert.ok(
      successors.length <= 1,
      "no duplicate successor, regardless of the race outcome",
    );

    for (const successor of successors) {
      await reminderQueue.remove(successor._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: successor._id });
    }
  });

  it("barrier: parent deleted AFTER the existence check, BEFORE successor creation", async () => {
    const parent = await createFixture("delete-test barrier", { recurring: true });

    await Reminder.updateOne(
      { _id: parent._id },
      { $set: { status: "sent", deliveredAt: new Date(), deliveryAttempts: 1 } },
    );

    const parentIdStr = parent._id.toString();

    let reachedResolve;
    let releaseResolve;

    const reached = new Promise((resolve) => {
      reachedResolve = resolve;
    });

    const release = new Promise((resolve) => {
      releaseResolve = resolve;
    });

    // Exact pause point: Reminder.create is the seam between
    // advanceRecurrence's existence check and the actual insert.
    const originalCreate = Reminder.create;

    Reminder.create = async function (doc) {
      if (
        doc &&
        doc.recurrenceParentId &&
        doc.recurrenceParentId.toString() === parentIdStr
      ) {
        reachedResolve();
        await release;
      }

      return originalCreate.call(this, doc);
    };

    try {
      const loaded = await Reminder.findById(parent._id).lean();

      const advancement = advanceRecurrence(loaded);

      await reached;

      await deleteReminder(parent._id);

      releaseResolve();

      const successor = await advancement;

      const stored = await Reminder.findById(successor._id).lean();

      assert.ok(
        stored,
        "a successor IS created independently after the parent was deleted",
      );
      assert.equal(
        stored.recurrenceParentId.toString(),
        parentIdStr,
        "the successor references the now-deleted parent",
      );
      assert.equal(stored.isRecurring, true);
      assert.equal(stored.recurrencePattern, "daily");

      assert.equal(await Reminder.findById(parent._id), null, "parent deleted");

      assert.equal(
        (await Reminder.find({ recurrenceParentId: parent._id }).lean()).length,
        1,
        "no duplicate successor",
      );

      const job = await reminderQueue.getJob(successor._id.toString());

      assert.ok(job, "successor job exists");
      assert.equal(job.id, successor._id.toString());
    } finally {
      releaseResolve?.();
      Reminder.create = originalCreate;
      await reminderQueue.remove(parentIdStr).catch(() => {});
    }
  });
});

describe("deletion and recurrence", () => {
  it("J: deleting a pending recurring reminder creates no successor", async () => {
    const reminder = await createFixture("delete-test recurring", { recurring: true });

    await deleteReminder(reminder._id);

    assert.equal(await Reminder.findById(reminder._id), null);
    assert.equal(await Reminder.countDocuments({ recurrenceParentId: reminder._id }), 0);
  });

  it("K: deleting the parent leaves the successor independent", async () => {
    const parent = await createFixture("delete-test parent", { recurring: true });

    const successor = await Reminder.create({
      phoneNumber: FIXTURE_PHONE,
      task: parent.task,
      reminderTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
      userId: TEST_USER_ID,
      isRecurring: true,
      recurrencePattern: "daily",
      recurrenceParentId: parent._id,
    });

    await Reminder.updateOne(
      { _id: parent._id },
      { $set: { status: "sent", deliveredAt: new Date(), deliveryAttempts: 1 } },
    );

    await deleteReminder(parent._id);

    assert.equal(await Reminder.findById(parent._id), null);

    const stored = await Reminder.findById(successor._id).lean();

    assert.ok(stored, "successor remains");
    assert.equal(stored.isRecurring, true);
    assert.equal(stored.recurrencePattern, "daily");
  });

  it("L: deleting the successor leaves the parent valid and recoverable", async () => {
    const parent = await createFixture("delete-test parent-l", { recurring: true });

    const successor = await Reminder.create({
      phoneNumber: FIXTURE_PHONE,
      task: parent.task,
      reminderTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
      userId: TEST_USER_ID,
      isRecurring: true,
      recurrencePattern: "daily",
      recurrenceParentId: parent._id,
    });

    await reminderQueue.add(
      "send-reminder",
      {
        reminderId: successor._id.toString(),
        task: successor.task,
        phoneNumber: successor.phoneNumber,
      },
      {
        jobId: successor._id.toString(),
        delay: 60_000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    await deleteReminder(successor._id);

    assert.equal(await Reminder.findById(successor._id), null);
    assert.equal(
      await reminderQueue.getJob(successor._id.toString()),
      undefined,
      "successor job removed",
    );

    const stored = await Reminder.findById(parent._id).lean();

    assert.ok(stored, "parent remains valid");

    const refreshed = await Reminder.findById(parent._id).lean();

    // The dangling recurrenceNextId is historical; reprocessing the parent
    // heals the chain by recreating the successor deterministically.
    const healed = await advanceRecurrence(refreshed);

    try {
      assert.equal((await successorsOf(parent._id)).length, 1);
      assert.equal(healed.recurrenceParentId.toString(), parent._id.toString());
    } finally {
      await reminderQueue.remove(healed._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: healed._id });
    }
  });
});

const successorsOf = async (parentId) =>
  Reminder.find({ recurrenceParentId: parentId }).lean();

describe("deletion API", () => {
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

  it("DELETE /api/reminders/:id returns 200 and removes the reminder", async () => {
    const reminder = await createFixture("delete-test api");

    const response = await fetch(`${baseUrl}/api/reminders/${reminder._id}`, {
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    assert.equal(await Reminder.findById(reminder._id), null);
  });

  it("DELETE /api/reminders/:id returns 404 for a missing reminder", async () => {
    const response = await fetch(
      `${baseUrl}/api/reminders/${new mongoose.Types.ObjectId()}`,
      { method: "DELETE" },
    );

    assert.equal(response.status, 404);
  });
});