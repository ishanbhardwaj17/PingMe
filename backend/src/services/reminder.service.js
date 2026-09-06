import Reminder from "../models/reminder.model.js";
import reminderQueue from "../queues/reminder.queue.js";
import { parseReminderText } from "../utils/parser.js";
import { normalizePhoneNumber } from "../utils/phone.js";
import {
  detectRecurrence,
  nextOccurrence,
  resolveFutureOccurrence,
} from "../utils/recurrenceParser.js";


export class ValidationError extends Error {}

/**
 * Schedule the BullMQ job for an already-persisted Reminder.
 *
 * Deterministic jobId (reminder _id) and the bounded retry/backoff options.
 * Adding with the same jobId is a no-op if the job already exists, so this
 * is safe to call repeatedly (used by recovery paths to heal orphaned
 * successors whose job was never scheduled).
 */
export const scheduleReminderJob = async (reminder) => {
  const delay = reminder.reminderTime.getTime() - Date.now();

  if (delay > 0) {
    await reminderQueue.add(
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
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      },
    );
  }
};

export const createReminder = async (data) => {
    let canonicalPhone;

    try {
        canonicalPhone = normalizePhoneNumber(data.phoneNumber);
    } catch (error) {
        throw new ValidationError(error.message);
    }

    const {
        reminderTime,
        isRecurring = false,
        recurrencePattern = null,
        recurrenceAnchorDay = null,
    } = data;

    const requestedTime = new Date(reminderTime);

    let effectiveTime;
    let anchorDay = null;

    if (isRecurring) {
        if (recurrencePattern === "monthly") {
            anchorDay = recurrenceAnchorDay ?? requestedTime.getDate();
        }

        effectiveTime = resolveFutureOccurrence(
            requestedTime,
            recurrencePattern,
            new Date(),
            anchorDay
        );
    } else if (requestedTime.getTime() <= Date.now()) {
        throw new ValidationError(
            "Reminder time is in the past. Please provide a future time."
        );
    } else {
        effectiveTime = requestedTime;
    }

    const reminder = await Reminder.create({
        ...data,
        phoneNumber: canonicalPhone,
        reminderTime: effectiveTime,
        recurrenceAnchorDay: anchorDay,
    });

    await scheduleReminderJob(reminder);

    return reminder;
};

/**
 * Finalize recurrence advancement on the parent occurrence. Repeatable and
 * stale-safe:
 * - recurrenceNextId is idempotently (re)set; concurrent callers converge
 *   on the same successor because successor identity is unique per parent.
 * - recurrenceAdvancedAt is set only when still null; once set, a
 *   stale/duplicate execution can never move it forward ($min keeps the
 *   earliest claim). Two targeted updates because $min does not apply when
 *   the current value is null (BSON ordering places null below dates).
 */
const finalizeAdvancement = async (parentId, successorId) => {
  const now = new Date();

  await Reminder.updateOne(
    { _id: parentId, recurrenceAdvancedAt: null },
    {
      $set: {
        recurrenceNextId: successorId,
        recurrenceAdvancedAt: now,
      },
    },
  );

  await Reminder.updateOne(
    { _id: parentId, recurrenceAdvancedAt: { $ne: null } },
    {
      $set: {
        recurrenceNextId: successorId,
      },
      $min: {
        recurrenceAdvancedAt: now,
      },
    },
  );
};

/**
 * Find reminders that may have been stranded by a worker crash:
 * an attempt was made (deliveryAttempts > 0), no delivery was recorded,
 * and the reminder is still pending with no terminal state.
 *
 * Optional olderThanMs bounds the search to reminders that have not been
 * touched recently (e.g. last attempt older than the BullMQ lock window).
 */
export const findStrandedReminders = async ({ olderThanMs = 0 } = {}) => {
  const filter = {
    status: "pending",
    deliveredAt: null,
    deliveryAttempts: { $gt: 0 },
  };

  if (olderThanMs > 0) {
    filter.updatedAt = { $lte: new Date(Date.now() - olderThanMs) };
  }

  return Reminder.find(filter).lean();
};

/**
 * Recover a stranded reminder by re-scheduling its BullMQ job.
 *
 * Explicit safety conditions (no invented locks):
 *
 * 1. Delivered reminders: no-op (never re-sent, never re-queued).
 * 2. Non-pending reminders (terminal states): no-op.
 * 3. Stale-safety window: when olderThanMs > 0, the reminder is refused
 *    (returns null) unless its updatedAt is older than the window. updatedAt
 *    is written by every state change, including the atomic
 *    deliveryAttempts increment at the start of each delivery attempt, so a
 *    live worker's in-flight attempt keeps the reminder inside the window.
 *    A recommended threshold is at least the BullMQ lock window plus the
 *    stalled-recovery margin (e.g. 120s for lockDuration 30s +
 *    stalledInterval 30s + retry backoff).
 * 4. Job liveness: if the reminder already has a waiting or delayed job the
 *    job will run on its own (no-op). If the job is active, a worker owns
 *    it (no-op). Only completed/failed jobs are removed before re-adding;
 *    a missing job is created. The deterministic jobId guarantees at most
 *    one queued job.
 * 5. Past-due reminders are scheduled immediately (delay 0): a late
 *    delivery is preferred over a permanently stranded reminder.
 *
 * @returns {Promise<object|null>} the reminder, or null when refused by
 *   the stale-safety window
 */
export const recoverStrandedReminder = async (
  reminderId,
  { olderThanMs = 0 } = {},
) => {
  const reminder = await Reminder.findById(reminderId);

  if (!reminder) return null;

  if (reminder.deliveredAt) return reminder;

  if (reminder.status !== "pending") return reminder;

  if (olderThanMs > 0) {
    const lastTouch =
      reminder.updatedAt?.getTime() ?? reminder.createdAt.getTime();

    if (Date.now() - lastTouch < olderThanMs) {
      return null;
    }
  }

  const job = await reminderQueue.getJob(reminderId.toString());

  if (job) {
    const state = await job.getState();

    if (state === "waiting" || state === "delayed" || state === "active") {
      return reminder;
    }

    await reminderQueue.remove(reminderId.toString()).catch(() => {});
  }

  const delay = reminder.reminderTime.getTime() - Date.now();

  if (delay > 0) {
    await scheduleReminderJob(reminder);
  } else {
    await reminderQueue.add(
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
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      },
    );
  }

  return reminder;
};

/**
 * Recoverably advance a recurring occurrence to its next occurrence.
 *
 * Successor identity is deterministic: the successor carries
 * recurrenceParentId = parent._id, and the unique sparse index on
 * recurrenceParentId guarantees at most one successor per parent, even
 * under concurrent executions.
 *
 * Recovery behavior:
 * - recurrenceNextId set and the successor exists: complete state, return it.
 * - recurrenceNextId set but successor missing: recreate (recovery).
 * - recurrenceNextId null but a successor exists (partial previous run):
 *   reuse it, re-schedule its job if missing (jobId-add is idempotent),
 *   and finalize the parent.
 * - Neither exists: create exactly one successor; a concurrent creator
 *   loses with E11000 and reuses the winner's successor.
 *
 * Remaining non-transactional windows (documented, no transactions in
 * this phase): a crash after the successor document is created but before
 * its job is scheduled leaves a successor without a job until the retry
 * heals it via scheduleReminderJob. A job that fails permanently with no
 * retry leaves the orphan visible via recurrenceParentId; no
 * reconciliation worker exists in this phase.
 *
 * @param {object} reminder - the delivered recurring occurrence
 * @returns {Promise<object>} the successor Reminder
 */
export const advanceRecurrence = async (reminder) => {
  const parentId = reminder._id;

  if (reminder.recurrenceNextId) {
    const existing = await Reminder.findById(reminder.recurrenceNextId);

    if (existing) {
      await finalizeAdvancement(parentId, existing._id);
      await scheduleReminderJob(existing);
      return existing;
    }
  }

  const found = await Reminder.findOne({ recurrenceParentId: parentId });

  if (found) {
    await finalizeAdvancement(parentId, found._id);
    await scheduleReminderJob(found);
    return found;
  }

  const nextDate = nextOccurrence(
    reminder.reminderTime,
    reminder.recurrencePattern,
    reminder.recurrenceAnchorDay,
  );

  let successor;

  try {
    successor = await Reminder.create({
      phoneNumber: reminder.phoneNumber,
      task: reminder.task,
      reminderTime: nextDate,
      isRecurring: true,
      recurrencePattern: reminder.recurrencePattern,
      recurrenceAnchorDay: reminder.recurrenceAnchorDay,
      recurrenceParentId: parentId,
      userId: reminder.userId,
    });

    await scheduleReminderJob(successor);
  } catch (error) {
    if (error.code === 11000) {
      const winner = await Reminder.findOne({ recurrenceParentId: parentId });

      if (winner) {
        await finalizeAdvancement(parentId, winner._id);
        return winner;
      }
    }

    throw error;
  }

  await finalizeAdvancement(parentId, successor._id);

  return successor;
};

export const getAllReminders = async () => {
    return await Reminder.find().sort({ reminderTime: 1 });
};

export const getUserReminders = async (userId) => {
    return await Reminder.find({
        userId,
    })
        .sort({
            reminderTime: 1,
        })
        .select("task status -_id")
        .lean();
};

export const getUpcomingReminders = async (userId) => {
    const now = new Date();

    return await Reminder.find({
        userId,
        reminderTime: {
            $gt: now,
        },
    })
        .sort({
            reminderTime: 1,
        })
        .lean();
};

export const getReminderStats = async (userId) => {
    const [total, pending, completed] = await Promise.all([
        Reminder.countDocuments({ userId }),
        Reminder.countDocuments({
            userId,
            status: "pending",
        }),
        Reminder.countDocuments({
            userId,
            status: "completed",
        }),
    ]);

    return {
        total,
        pending,
        completed,
    };
};

export const getReminderById = async (id) => {
    return await Reminder.findById(id);
};

export const deleteReminder = async (id) => {
    return await Reminder.findByIdAndDelete(id);
};

/**
 * Cancel a pending reminder.
 *
 * Lifecycle rule (verified by tests):
 * - pending -> cancelled: the only allowed transition.
 * - sent / failed -> immutable: returned unchanged (no resurrection, no
 *   regression, no accidental "cancelled" rewrite of terminal states).
 * - cancelled -> idempotent no-op.
 *
 * The state transition is a single atomic conditional update
 * ({ _id, status: "pending" }), so it cannot race a worker: whichever of
 * the cancellation or the delivery attempt gate wins, the loser observes
 * the terminal state and backs off (the delivery attempt gate refuses to
 * send once the reminder is not pending).
 *
 * The reminder's BullMQ job is removed after the transition (no-op when
 * missing or when the job is already consumed). An in-flight worker that
 * already passed the delivery gate may still complete its send; the
 * success transition itself is guarded against regressing "cancelled" to
 * "sent" in deliverReminder. Successors of recurring reminders are not
 * touched: cancellation applies to one occurrence, not the chain.
 *
 * @returns {Promise<object|null>} the resulting reminder, or null when
 *   the id does not exist
 */
export const cancelReminder = async (reminderId) => {
  const cancelled = await Reminder.findOneAndUpdate(
    { _id: reminderId, status: "pending" },
    { $set: { status: "cancelled" } },
    { new: true },
  );

  if (cancelled) {
    await reminderQueue.remove(reminderId.toString()).catch(() => {});
    return cancelled;
  }

  const existing = await Reminder.findById(reminderId);

  return existing ?? null;
};

export const createReminderFromText = async ({
    userId,
  phoneNumber,
  text,
}) => {
  const parsed = parseReminderText(text);
    const recurrencePattern = detectRecurrence(text);
    const isRecurring = recurrencePattern !== null;

  return await createReminder({
        userId,
    phoneNumber,
    task: parsed.task,
    reminderTime: parsed.reminderTime,
        isRecurring,
        recurrencePattern,
  });
};