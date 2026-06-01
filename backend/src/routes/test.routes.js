import express from "express";
import Reminder from "../models/reminder.model.js";

const router = express.Router();

router.post("/create", async (req, res) => {
    try {
        const reminder = await Reminder.create({
            phoneNumber: "+911234567890",
            task: "Pay Electricity Bill",
            reminderTime: new Date(),
        });

        res.status(201).json(reminder);
    } catch (error) {
        res.status(500).json({
            message: error.message,
        });
    }
});

export default router;