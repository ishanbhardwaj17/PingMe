import Reminder from "../models/reminder.model.js";
import reminderQueue from "../queues/reminder.queue.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";


export const createReminder = async (data) => {
    const reminder = await Reminder.create(data);

    const delay = new Date(reminder.reminderTime).getTime() - Date.now();

    if (delay > 0) {
        await reminderQueue.add(
            "send-reminder",
            {
                reminderId: reminder._id.toString(),
                task: reminder.task,
                phoneNumber: reminder.phoneNumber,
            },
            {
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