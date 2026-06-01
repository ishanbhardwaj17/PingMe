import * as reminderService from "../services/reminder.service.js";

export const createReminder = async (req, res) => {
    try {
        const reminder = await reminderService.createReminder(req.body);

        res.status(201).json({
            success: true,
            reminder,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

export const getAllReminders = async (req, res) => {
    try {
        const reminders = await reminderService.getAllReminders();

        res.status(200).json({
            success: true,
            reminders,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

export const deleteReminder = async (req, res) => {
    try {
        await reminderService.deleteReminder(req.params.id);

        res.status(200).json({
            success: true,
            message: "Reminder deleted",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};