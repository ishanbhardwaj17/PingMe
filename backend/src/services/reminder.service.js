import Reminder from "../models/reminder.model.js";

export const createReminder = async (data) => {
    return await Reminder.create(data);
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