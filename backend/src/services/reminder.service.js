import Reminder from "../models/reminder.model.js";
import reminderQueue from "../queues/reminder.queue.js";
import { parseReminderText } from "../utils/parser.js";
import { normalizePhoneNumber } from "../utils/phone.js";
import {
  detectRecurrence,
  resolveFutureOccurrence,
} from "../utils/recurrenceParser.js";


export class ValidationError extends Error {}

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

    const delay = effectiveTime.getTime() - Date.now();

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
            }
        );
    }

    return reminder;
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