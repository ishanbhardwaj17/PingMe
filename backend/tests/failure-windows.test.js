import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import Reminder from "../src/models/reminder.model.js";
import reminderQueue from "../src/queues/reminder.queue.js";
import redisConnection from "../src/config/redis.js";
import {
  advanceRecurrence,
  createReminder,
} from "../src/services/reminder.service.js";
import { deliverReminder } from "../src/services/reminder-delivery.service.js";

/**
 * EXACTLY-ONCE LIMITATION (documented, not tested away):
 *
 * There is an unavoidable external side-effect window:
 *   Meta accepts outbound WhatsApp message
 *     -> process crashes
 *     -> Mongo deliveredAt was not persisted
 * On restart/retry the message may be sent again.
 *
 * PingMe does NOT guarantee exactly-once external WhatsApp delivery. It
 * guarantees the strongest recoverability/idempotency available within the
 * current MongoDB + BullMQ + WhatsApp architecture: a reminder with a
 * durably persisted deliveredAt is never sent again, and recurrence
 * advancement is deterministic and recoverable.
 */

const TEST_USER_ID = new mongoose.Types.ObjectId();
const FIXTURE_PHONE = "910000000003";
const TASK_PREFIX = "fw-test";

const transientError = () =>
  Object.assign(new Error("ECONNRESET: socket closed"), { request: {} });

const permanentError = () =>
  Object.assign(new Error("Bad Request: invalid number"), {
    response: { status: 400, data: {} },
  });

const successResult = (id = "wamid.fw.test") => ({
  messaging_product: "whatsapp",
  messages: [{ id }],
});

let currentSendFn;
let worker;
let harnessQueue;

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

const createFixture = async (task, { recurring = false, pattern = "daily" } = {}) =>
  Reminder.create({
    phoneNumber: FIXTURE_PHONE,
    task,
    reminderTime: new Date(Date.now() + 60 * 60 * 1000),
    userId: TEST_USER_ID,
    isRecurring: recurring,
    recurrencePattern: recurring ? pattern : null,
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

const successorsOf = async (parentId) =>
  Reminder.find({ recurrenceParentId: parentId }).lean();

const cleanup = async () => {
  for (const queue of [harnessQueue, reminderQueue]) {
    if (!queue) continue;

    const delayed = await queue.getDelayed();

    for (const job of delayed) {
      if (job && job.data && job.data.task && job.data.task.startsWith(TASK_PREFIX)) {
        await queue.remove(job.id).catch(() => {});
      }
    }

    const completed = await queue.getCompleted();

    for (const job of completed) {
      if (job && job.data && job.data.task && job.data.task.startsWith(TASK_PREFIX)) {
        await queue.remove(job.id).catch(() => {});
      }
    }
  }

  await Reminder.deleteMany({ task: { $regex: /^fw-test/ } });
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Reminder.init();

  // Dedicated queue so this file's worker never competes with other test
  // files' workers on the shared "reminders" queue (parallel-file isolation).
  harnessQueue = new Queue("reminders-fw-harness", {
    connection: redisConnection,
  });

  await cleanup();

  worker = new Worker("reminders-fw-harness", processJob, {
    connection: redisConnection,
  });
});

afterEach(async () => {
  currentSendFn = undefined;
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

describe("A: worker retry behavior", () => {
  it("A1: succeeds on the first attempt without retries", async () => {
    const reminder = await createFixture("fw-test a1");

    currentSendFn = async () => successResult("wamid.fw.a1");

    await addJob(reminder);

    const done = await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "sent" ? current : null;
    });

    assert.equal(done.deliveryAttempts, 1);
    assert.ok(done.deliveredAt);
    assert.equal(done.deliveredMessageId, "wamid.fw.a1");
    assert.equal(done.lastError, null);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal((await Reminder.findById(reminder._id).lean()).deliveryAttempts, 1);
  });

  it("A2: first attempt fails, second succeeds, exactly two sends", async () => {
    const reminder = await createFixture("fw-test a2");
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      if (calls === 1) throw transientError();
      return successResult("wamid.fw.a2");
    };

    await addJob(reminder);

    const done = await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "sent" ? current : null;
    });

    assert.equal(calls, 2);
    assert.equal(done.deliveryAttempts, 2);
    assert.equal(done.status, "sent");
    assert.ok(done.deliveredAt);
    assert.equal(done.lastError, null);
  });

  it("A3: three retryable failures end in failed with no fourth attempt", async () => {
    const reminder = await createFixture("fw-test a3");
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      throw transientError();
    };

    await addJob(reminder);

    const failed = await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "failed" ? current : null;
    });

    assert.equal(calls, 3);
    assert.equal(failed.deliveryAttempts, 3);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "ECONNRESET: socket closed");

    const before = calls;

    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.equal(calls, before);
  });

  it("A4: permanent failure does not retry", async () => {
    const reminder = await createFixture("fw-test a4");
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      throw permanentError();
    };

    await addJob(reminder);

    const failed = await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "failed" ? current : null;
    });

    assert.equal(calls, 1);
    assert.equal(failed.deliveryAttempts, 1);
    assert.equal(failed.lastError, "Bad Request: invalid number");

    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.equal(calls, 1);
  });
});

describe("B: already-delivered guard", () => {
  it("B1: direct deliverReminder does not send for a delivered reminder", async () => {
    const reminder = await createFixture("fw-test b1");

    reminder.status = "sent";
    reminder.deliveredAt = new Date();
    reminder.deliveredMessageId = "wamid.fw.b1";
    await reminder.save();

    let calls = 0;

    const outcome = await deliverReminder(
      reminder,
      { opts: { attempts: 3 }, attemptsMade: 0 },
      async () => {
        calls++;
        return successResult();
      },
    );

    assert.equal(outcome.alreadyDelivered, true);
    assert.equal(calls, 0);

    const stored = await Reminder.findById(reminder._id).lean();

    assert.equal(stored.status, "sent");
    assert.ok(stored.deliveredAt);
  });

  it("B2: worker invocation does not bypass the guard", async () => {
    const reminder = await createFixture("fw-test b2");

    reminder.status = "sent";
    reminder.deliveredAt = new Date();
    await reminder.save();

    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult();
    };

    await addJob(reminder);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(calls, 0, "worker must not send again");

    const stored = await Reminder.findById(reminder._id).lean();

    assert.equal(stored.status, "sent");
    assert.ok(stored.deliveredAt);
  });
});

describe("C: delivery failure must not advance recurrence", () => {
  it("leaves no successor, no parent link, no successor job", async () => {
    const reminder = await createFixture("fw-test c", { recurring: true });

    currentSendFn = async () => {
      throw transientError();
    };

    await addJob(reminder);

    await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "failed" ? current : null;
    });

    const original = await Reminder.findById(reminder._id).lean();

    assert.equal(original.status, "failed");
    assert.equal(original.recurrenceNextId, null);
    assert.equal(original.recurrenceAdvancedAt, null);
    assert.equal((await successorsOf(reminder._id)).length, 0);

    for (const queue of [harnessQueue, reminderQueue]) {
      const delayed = await queue.getDelayed();

      assert.equal(
        delayed.some(
          (job) =>
            job &&
            job.data &&
            job.data.task &&
            job.data.task.startsWith("fw-test c"),
        ),
        false,
        "no successor job exists",
      );
    }
  });
});

describe("D: successful recurring delivery", () => {
  it("produces exactly one linked successor with one deterministic job", async () => {
    const reminder = await createFixture("fw-test d", { recurring: true });

    currentSendFn = async () => successResult("wamid.fw.d");

    await addJob(reminder);

    await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "sent" && current.recurrenceNextId
        ? current
        : null;
    });

    const original = await Reminder.findById(reminder._id).lean();

    assert.equal(original.status, "sent");
    assert.ok(original.deliveredAt);
    assert.ok(original.recurrenceNextId);
    assert.ok(original.recurrenceAdvancedAt);

    const successors = await successorsOf(reminder._id);

    assert.equal(successors.length, 1);
    assert.equal(
      successors[0].recurrenceParentId.toString(),
      reminder._id.toString(),
    );

    const successorJob = await reminderQueue.getJob(
      successors[0]._id.toString(),
    );

    assert.ok(successorJob, "successor job exists");
    assert.equal(successorJob.id, successors[0]._id.toString());
  });
});

describe("E: concurrent recurrence advancement", () => {
  it("exactly one successor from five concurrent callers", async () => {
    const reminder = await createFixture("fw-test e", { recurring: true });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => advanceRecurrence(reminder)),
    );

    const distinct = new Set(results.map((r) => r._id.toString()));

    try {
      assert.equal(distinct.size, 1);
      assert.equal((await successorsOf(reminder._id)).length, 1);

      const original = await Reminder.findById(reminder._id).lean();

      assert.equal(
        original.recurrenceNextId.toString(),
        results[0]._id.toString(),
      );
      assert.ok(original.recurrenceAdvancedAt);
    } finally {
      const successors = await successorsOf(reminder._id);

      for (const successor of successors) {
        await reminderQueue.remove(successor._id.toString()).catch(() => {});
        await Reminder.deleteOne({ _id: successor._id });
      }
    }
  });
});

describe("F: orphan successor recovery (real queue failure)", () => {
  it("reuses the orphan, heals the job, repairs the parent", async () => {
    const reminder = await createFixture("fw-test f", { recurring: true });

    redisConnection.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    let threw = false;

    try {
      await advanceRecurrence(reminder);
    } catch {
      threw = true;
    }

    assert.equal(threw, true, "queue failure surfaces as a thrown error");

    redisConnection.connect().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const orphans = await successorsOf(reminder._id);

    try {
      assert.equal(orphans.length, 1, "successor persisted before the failure");

      const recovered = await advanceRecurrence(reminder);

      assert.equal(
        recovered._id.toString(),
        orphans[0]._id.toString(),
        "orphan reused, no second successor",
      );

      const original = await Reminder.findById(reminder._id).lean();

      assert.equal(original.recurrenceNextId.toString(), orphans[0]._id.toString());
      assert.ok(original.recurrenceAdvancedAt);

      const job = await reminderQueue.getJob(orphans[0]._id.toString());

      assert.ok(job, "BullMQ job healed");
      assert.equal(job.id, orphans[0]._id.toString());
    } finally {
      if (orphans.length) {
        await reminderQueue.remove(orphans[0]._id.toString()).catch(() => {});
        await Reminder.deleteOne({ _id: orphans[0]._id });
      }
    }
  });
});

describe("G: missing BullMQ job healing", () => {
  it("reuses the successor and recreates its job with the deterministic jobId", async () => {
    const parent = await createFixture("fw-test g", { recurring: true });
    const successor = await Reminder.create({
      phoneNumber: FIXTURE_PHONE,
      task: parent.task,
      reminderTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
      userId: TEST_USER_ID,
      isRecurring: true,
      recurrencePattern: "daily",
      recurrenceParentId: parent._id,
    });

    parent.recurrenceNextId = successor._id;
    parent.recurrenceAdvancedAt = new Date();
    await parent.save();

    assert.equal(
      await reminderQueue.getJob(successor._id.toString()),
      undefined,
      "precondition: successor has no job",
    );

    const recovered = await advanceRecurrence(parent);

    try {
      assert.equal(recovered._id.toString(), successor._id.toString());
      assert.equal((await successorsOf(parent._id)).length, 1);

      const job = await reminderQueue.getJob(successor._id.toString());

      assert.ok(job, "job recreated");
      assert.equal(job.id, successor._id.toString());
    } finally {
      await reminderQueue.remove(successor._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: successor._id });
    }
  });
});

describe("H: deleted successor recovery", () => {
  it("creates a new deterministic successor and repairs the parent", async () => {
    const parent = await createFixture("fw-test h", { recurring: true });
    const ghost = new mongoose.Types.ObjectId();

    parent.recurrenceNextId = ghost;
    await parent.save();

    const recovered = await advanceRecurrence(parent);

    try {
      assert.notEqual(recovered._id.toString(), ghost.toString());

      const original = await Reminder.findById(parent._id).lean();

      assert.equal(original.recurrenceNextId.toString(), recovered._id.toString());
      assert.ok(original.recurrenceAdvancedAt);
      assert.equal((await successorsOf(parent._id)).length, 1);
    } finally {
      await reminderQueue.remove(recovered._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: recovered._id });
    }
  });
});

describe("I: finalization failure window", () => {
  it("recovers when the parent was never finalized (post-failure state)", async () => {
    // finalizeAdvancement is a single atomic $set (recurrenceNextId +
    // recurrenceAdvancedAt together), so it cannot be partially applied.
    // Its only failure modes are "did not run" (crash) or "failed entirely"
    // (DB error), both of which converge on this state: a successor exists
    // by recurrenceParentId while the parent is unfinalized.
    const parent = await createFixture("fw-test i", { recurring: true });

    const successor = await Reminder.create({
      phoneNumber: FIXTURE_PHONE,
      task: parent.task,
      reminderTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
      userId: TEST_USER_ID,
      isRecurring: true,
      recurrencePattern: "daily",
      recurrenceParentId: parent._id,
    });

    try {
      const recovered = await advanceRecurrence(parent);

      assert.equal(recovered._id.toString(), successor._id.toString());
      assert.equal((await successorsOf(parent._id)).length, 1);

      const original = await Reminder.findById(parent._id).lean();

      assert.equal(original.recurrenceNextId.toString(), successor._id.toString());
      assert.ok(original.recurrenceAdvancedAt);

      const job = await reminderQueue.getJob(successor._id.toString());

      assert.ok(job, "successor job exists after recovery");
    } finally {
      await reminderQueue.remove(successor._id.toString()).catch(() => {});
      await Reminder.deleteOne({ _id: successor._id });
    }
  });
});

describe("J: replay of a delivered recurring reminder", () => {
  it("does not re-send and keeps the same successor", async () => {
    const reminder = await createFixture("fw-test j", { recurring: true });
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult("wamid.fw.j");
    };

    await addJob(reminder);

    await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "sent" && current.recurrenceNextId
        ? current
        : null;
    });

    const first = await Reminder.findById(reminder._id).lean();
    const deliveredAt = first.deliveredAt;
    const deliveredMessageId = first.deliveredMessageId;
    const successorId = first.recurrenceNextId.toString();
    const sendsAfterFirst = calls;

    const job = await harnessQueue.getJob(reminder._id.toString());

    await processJob(job);

    const second = await Reminder.findById(reminder._id).lean();

    assert.equal(calls, sendsAfterFirst, "no additional send on replay");
    assert.equal(second.deliveredAt.getTime(), deliveredAt.getTime());
    assert.equal(second.deliveredMessageId, deliveredMessageId);
    assert.equal(second.recurrenceNextId.toString(), successorId);
    assert.equal((await successorsOf(reminder._id)).length, 1);
  });
});

describe("K: concurrent duplicate worker execution", () => {
  it("two concurrent executions of a delivered recurring reminder: zero sends, one successor", async () => {
    const reminder = await createFixture("fw-test k", { recurring: true });
    let calls = 0;

    currentSendFn = async () => {
      calls++;
      return successResult("wamid.fw.k");
    };

    await addJob(reminder);

    await waitFor(async () => {
      const current = await Reminder.findById(reminder._id).lean();

      return current.status === "sent" && current.recurrenceNextId
        ? current
        : null;
    });

    const sendsBefore = calls;
    const job = await harnessQueue.getJob(reminder._id.toString());

    await Promise.all([processJob(job), processJob(job)]);

    assert.equal(calls, sendsBefore, "zero additional sends");
    assert.equal((await successorsOf(reminder._id)).length, 1);
  });
});

describe("L: BullMQ job identity", () => {
  it("one job per reminder across duplicate and concurrent enqueues", async () => {
    const reminder = await createFixture("fw-test l");

    currentSendFn = async () => successResult("wamid.fw.l");

    await addJob(reminder, { delay: 5 * 60_000 });

    const jobId = reminder._id.toString();
    const first = await harnessQueue.getJob(jobId);

    assert.ok(first);

    await harnessQueue.add(
      "send-reminder",
      {
        reminderId: jobId,
        task: reminder.task,
        phoneNumber: reminder.phoneNumber,
      },
      { jobId, delay: 2 * 60_000, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    );

    await Promise.all(
      Array.from({ length: 5 }, () =>
        harnessQueue.add(
          "send-reminder",
          {
            reminderId: jobId,
            task: reminder.task,
            phoneNumber: reminder.phoneNumber,
          },
          { jobId, delay: 3 * 60_000, attempts: 3 },
        ),
      ),
    );

    const delayed = await harnessQueue.getDelayed();

    assert.equal(
      delayed.filter((job) => job && job.id === jobId).length,
      1,
      "exactly one job for the reminder",
    );
  });
});