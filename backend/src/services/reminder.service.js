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
 * Finalize recurrence advancement on the parent occurrence. Repeatable:
 * re-setting the same successor id and timestamp is idempotent.
 */
const finalizeAdvancement = async (parentId, successorId) => {
  await Reminder.updateOne(
    { _id: parentId },
    {
      $set: {
        recurrenceNextId: successorId,
        recurrenceAdvancedAt: new Date(),
      },
    },
  );
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