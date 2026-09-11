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
 * Find reminders that may be stranded: pending, undelivered, overdue, and
 * not in any terminal state.
 *
 * Covers two classes:
 * - deliveryAttempts > 0: delivery started but never completed (worker
 *   crash / stalled job that was never recovered).
 * - deliveryAttempts = 0: the reminder was persisted but its BullMQ job
 *   was never created (scheduling failure at creation) or was lost.
 *
 * The overdue bound (reminderTime in the past) is what makes a
 * zero-attempt reminder distinguishable from an ordinary future reminder.
 *
 * Optional olderThanMs bounds the search to reminders that have not been
 * touched recently (e.g. last attempt older than the BullMQ lock window).
 */
export const findStrandedReminders = async ({ olderThanMs = 0 } = {}) => {
  const filter = {
    status: "pending",
    deliveredAt: null,
    reminderTime: { $lt: new Date() },
  };

  if (olderThanMs > 0) {
    filter.updatedAt = { $lte: new Date(Date.now() - olderThanMs) };
  }

  return Reminder.find(filter).lean();
};

/**
 * Run one strand-recovery pass: detect overdue pending reminders without a
 * live job and re-schedule them through the existing safety gates.
 *
 * Bounded and idempotent: per-reminder errors are isolated, the stale
 * window and job-liveness gates in recoverStrandedReminder prevent racing
 * an active worker or a live job, and the deterministic jobId makes
 * repeated/concurrent scheduling converge on exactly one job.
 *
 * @returns {Promise<{detected: number, recovered: number}>}
 */
export const runStrandRecoveryPass = async ({
  olderThanMs = 120_000,
} = {}) => {
  const strands = await findStrandedReminders({ olderThanMs });

  let recovered = 0;

  for (const strand of strands) {
    try {
      const result = await recoverStrandedReminder(strand._id, {
        olderThanMs,
      });

      if (result) {
        recovered++;
      }
    } catch (error) {
      console.error(
        `Strand recovery failed for ${strand._id}:`,
        error.message,
      );
    }
  }

  return { detected: strands.length, recovered };
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
 * Stop a recurring reminder: the selected occurrence keeps its schedule but
 * no successor is ever created from it again (advanceRecurrence refuses).
 *
 * The stop is authoritative against a concurrently racing advanceRecurrence:
 * - the atomic conditional update marks the selected occurrence once;
 * - any successor already created by an in-flight advance is cascaded
 *   (flagged) so it also refuses to advance;
 * - advanceRecurrence itself re-checks the parent after creating a
 *   successor, closing the last window.
 *
 * Delivered history is never rewritten; unrelated reminders are untouched.
 *
 * @returns {Promise<object|null>} the stopped occurrence, or null when it
 *   does not exist, is not pending, or is already stopped
 */
export const stopRecurringReminder = async (reminderId) => {
  const stopped = await Reminder.findOneAndUpdate(
    { _id: reminderId, status: "pending", recurrenceStoppedAt: null },
    { $set: { recurrenceStoppedAt: new Date() } },
    { returnDocument: "after" },
  );

  if (stopped) {
    await Reminder.updateMany(
      { recurrenceParentId: reminderId, recurrenceStoppedAt: null },
      { $set: { recurrenceStoppedAt: new Date() } },
    );
  }

  return stopped;
};

/**
 * If the parent occurrence was stopped while a successor was being created
 * by a concurrent advanceRecurrence, flag the successor too so the chain
 * cannot continue past it.
 */
const stopSuccessorIfParentStopped = async (parentId, successorId) => {
  const parent = await Reminder.findById(parentId)
    .select("recurrenceStoppedAt")
    .lean();

  if (parent?.recurrenceStoppedAt) {
    await Reminder.updateOne(
      { _id: successorId, recurrenceStoppedAt: null },
      { $set: { recurrenceStoppedAt: new Date() } },
    );
  }
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

  // Deletion is authoritative: a parent that no longer exists must never
  // create or advance anything (no orphan successors, no resurrection).
  // This covers the delete-vs-advancement race deterministically.
  const parentExists = await Reminder.exists({ _id: parentId });

  if (!parentExists) {
    return null;
  }

  // A stopped series must never produce another successor.
  if (reminder.recurrenceStoppedAt) {
    return null;
  }

  if (reminder.recurrenceNextId) {
    const existing = await Reminder.findById(reminder.recurrenceNextId);

    if (existing) {
      await finalizeAdvancement(parentId, existing._id);
      await scheduleReminderJob(existing);
      await stopSuccessorIfParentStopped(parentId, existing._id);
      return existing;
    }
  }

  const found = await Reminder.findOne({ recurrenceParentId: parentId });

  if (found) {
    await finalizeAdvancement(parentId, found._id);
    await scheduleReminderJob(found);
    await stopSuccessorIfParentStopped(parentId, found._id);
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

  // Close the stop-vs-advance race: if the user stopped the series while
  // this successor was being created, flag it so the chain ends here.
  await stopSuccessorIfParentStopped(parentId, successor._id);

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
    return await Reminder.find(getSelectableReminderFilter(userId))
        .sort({
            reminderTime: 1,
            _id: 1,
        })
        .lean();
};

/**
 * The most recently delivered reminder for a user (deliveredAt descending,
 * _id descending as the deterministic tie-breaker). Read-only; returns null
 * when the user has no delivered reminder.
 */
export const getLatestDeliveredReminder = async (userId) => {
    return await Reminder.findOne({
        userId,
        deliveredAt: { $ne: null },
    })
        .sort({ deliveredAt: -1, _id: -1 })
        .lean();
};

/**
 * Selectable reminders whose scheduled time falls inside [start, end).
 *
 * Uses the same selectable philosophy as getUpcomingReminders (pending,
 * undelivered, user-owned) with a direct MongoDB range query — sent, failed,
 * cancelled, delivered, and out-of-range reminders are never returned. The
 * order matches the numbered list (reminderTime ascending, _id ascending).
 */
export const getRemindersInTimeRange = async (userId, start, end) => {
    return await Reminder.find({
        userId,
        status: "pending",
        deliveredAt: null,
        reminderTime: {
            $gte: start,
            $lt: end,
        },
    })
        .sort({
            reminderTime: 1,
            _id: 1,
        })
        .lean();
};

/**
 * The shared "selectable reminder" filter used by the WhatsApp list and by
 * numbered selection: pending, undelivered, future reminders only. Sent,
 * failed, cancelled, delivered, and past reminders are never selectable.
 */
const getSelectableReminderFilter = (userId) => {
    const now = new Date();

    return {
        userId,
        status: "pending",
        deliveredAt: null,
        reminderTime: {
            $gt: now,
        },
    };
};

/**
 * Select one upcoming reminder by its number in the numbered list.
 *
 * Uses exactly the same query and ordering as getUpcomingReminders
 * (reminderTime ascending, _id ascending as the deterministic tie-breaker),
 * so list numbering and selection always agree. Enforces user ownership and
 * never selects sent/failed/cancelled/delivered/past reminders.
 *
 * @returns {Promise<object|null>} the selected reminder or null
 */
export const getReminderByNumberForUser = async (userId, number) => {
    if (!Number.isInteger(number) || number < 1) {
        return null;
    }

    const reminder = await Reminder.findOne(getSelectableReminderFilter(userId))
        .sort({ reminderTime: 1, _id: 1 })
        .skip(number - 1)
        .lean();

    return reminder ?? null;
};

/**
 * Update a pending reminder's task and reminderTime, preserving its _id and
 * BullMQ job identity (jobId = reminder._id).
 *
 * Only status pending can be edited. The old scheduled job is removed and
 * the new time is scheduled through the existing scheduleReminderJob. The
 * remove -> schedule gap is a small window that the existing strand
 * recovery covers if the reminder becomes overdue with no job.
 *
 * @returns {Promise<object|null>} the updated reminder, or null when the
 *   reminder does not exist or is not editable
 */
export const updateReminder = async (reminderId, { task, reminderTime }) => {
    const updated = await Reminder.findOneAndUpdate(
        { _id: reminderId, status: "pending" },
        { $set: { task, reminderTime } },
        { returnDocument: "after" },
    );

    if (!updated) {
        return null;
    }

    await reminderQueue.remove(reminderId.toString()).catch(() => {});
    await scheduleReminderJob(updated);

    return updated;
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

/**
 * Hard-delete a reminder: the MongoDB document no longer exists.
 *
 * Deletion is separate from cancellation (which keeps the document with
 * status "cancelled"). Semantics:
 * - The document is removed authoritatively; a future worker execution can
 *   never deliver it (findById -> null terminates processing, and the
 *   delivery gate cannot match a deleted document).
 * - The reminder's BullMQ job is removed when safely possible (waiting,
 *   delayed, completed, failed). An in-flight active job cannot be removed
 *   (verified against BullMQ 5.78): the worker may still be executing, but
 *   its MongoDB writes cannot match a deleted document, so the durable
 *   deletion state remains authoritative.
 * - No recurrence cascade: existing successors remain independent; deleting
 *   a parent does not advance or corrupt anything. A deleted parent's
 *   recurrenceNextId may dangle until the recovery path re-creates the
 *   successor if the parent is ever reprocessed.
 * - The external side-effect race is unchanged: a WhatsApp request that has
 *   already started cannot be retracted by deletion.
 *
 * @returns {Promise<object|null>} the deleted document, or null when the
 *   id does not exist
 */
export const deleteReminder = async (id) => {
    const reminder = await Reminder.findByIdAndDelete(id);

    if (reminder) {
        await reminderQueue.remove(id.toString()).catch(() => {});
    }

    return reminder;
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
    { returnDocument: "after" },
  );

  if (cancelled) {
    await reminderQueue.remove(reminderId.toString()).catch(() => {});
    return cancelled;
  }

  const existing = await Reminder.findById(reminderId);

  return existing ?? null;
};

/**
 * Bulk-cancel all pending reminders for a user (WhatsApp has no
 * conversational reminder-selection state, so cancellation is bulk-only).
 *
 * - Only status pending is affected; sent/failed/cancelled are untouched.
 * - The transition is a single atomic updateMany.
 * - Each reminder's BullMQ job is removed using the deterministic jobId.
 *
 * @returns {Promise<number>} how many reminders were cancelled
 */
export const cancelPendingRemindersForUser = async (userId) => {
  const pending = await Reminder.find({ userId, status: "pending" })
    .select("_id")
    .lean();

  if (pending.length === 0) {
    return 0;
  }

  const result = await Reminder.updateMany(
    { userId, status: "pending" },
    { $set: { status: "cancelled" } },
  );

  for (const reminder of pending) {
    await reminderQueue.remove(reminder._id.toString()).catch(() => {});
  }

  return result.modifiedCount;
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