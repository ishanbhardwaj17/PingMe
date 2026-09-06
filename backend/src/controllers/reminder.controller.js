import * as reminderService from "../services/reminder.service.js";
import { findOrCreateUser } from "../services/user.service.js";

export const createReminder = async (req, res) => {
    try {
        const reminder = await reminderService.createReminder(req.body);

        res.status(201).json({
            success: true,
            reminder,
        });
    } catch (error) {
        if (error instanceof reminderService.ValidationError) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

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
        const reminder = await reminderService.deleteReminder(req.params.id);

        if (!reminder) {
            return res.status(404).json({
                success: false,
                message: "Reminder not found",
            });
        }

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

export const cancelReminder = async (req, res) => {
    try {
        const reminder = await reminderService.cancelReminder(req.params.id);

        if (!reminder) {
            return res.status(404).json({
                success: false,
                message: "Reminder not found",
            });
        }

        res.status(200).json({
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

export const createReminderFromText = async (req, res) => {
    try {
        const { phoneNumber, text } = req.body;

        const user = await findOrCreateUser(phoneNumber);

        const reminder = await reminderService.createReminderFromText({
            userId: user._id,
            phoneNumber,
            text,
        });

        res.status(201).json({
            success: true,
            reminder,
        });
    } catch (error) {
        if (error instanceof reminderService.ValidationError) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};