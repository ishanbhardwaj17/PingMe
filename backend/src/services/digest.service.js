import Reminder from "../models/reminder.model.js";

export const getTodaysReminders = async (userId) => {
    const start = new Date();

    start.setHours(0, 0, 0, 0);

    const end = new Date();

    end.setHours(23, 59, 59, 999);

    return await Reminder.find({
        userId,
        reminderTime: {
            $gte: start,
            $lte: end,
        },
        status: "pending",
    }).sort({
        reminderTime: 1,
    });
};

export const generateDigest = async (userId) => {
    const reminders = await getTodaysReminders(userId);

    if (!reminders.length) {
        return "No reminders for today 🎉";
    }

    let message = "🌅 Good Morning\n\nToday's Schedule\n\n";

    reminders.forEach((reminder) => {
        const time = new Date(
            reminder.reminderTime
        ).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });

        message += `• ${reminder.task} - ${time}\n`;
    });

    return message;
};