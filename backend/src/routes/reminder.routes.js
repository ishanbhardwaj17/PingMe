import express from "express";

import {
    createReminder,
    getAllReminders,
    deleteReminder,
    createReminderFromText
} from "../controllers/reminder.controller.js";
import User from "../models/user.model.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import { generateDigest } from "../services/digest.service.js";
const router = express.Router();

router.post("/", createReminder);

router.get("/", getAllReminders);

router.delete("/:id", deleteReminder);

router.get("/digest/:phoneNumber", async (req, res) => {
  try {
    const user = await User.findOne({
      phoneNumber: req.params.phoneNumber,
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const digest = await generateDigest(user._id);

    res.json({
      digest,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
});

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

router.post("/test-recurrence", (req, res) => {
  const { text } = req.body;

  const recurrencePattern =
    detectRecurrence(text);

  res.json({
    recurrencePattern,
    isRecurring: recurrencePattern !== null,
  });
});

export default router;