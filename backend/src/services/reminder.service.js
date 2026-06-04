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