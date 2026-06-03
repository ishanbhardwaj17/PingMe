import express from "express";

import {
    createReminder,
    getAllReminders,
    deleteReminder,
    createReminderFromText
} from "../controllers/reminder.controller.js";
import { parseReminderText } from "../utils/parser.js";

const router = express.Router();

router.post("/", createReminder);

router.get("/", getAllReminders);

router.delete("/:id", deleteReminder);

router.post("/parse", (req, res) => {
    try {
        const { text } = req.body;

        const result = parseReminderText(text);

        res.json(result);
    } catch (error) {
        res.status(400).json({
            message: error.message,
        });
    }
});

router.post(
    "/create-from-text",
    createReminderFromText
);

export default router;