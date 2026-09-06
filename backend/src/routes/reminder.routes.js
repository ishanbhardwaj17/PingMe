import express from "express";

import {
    createReminder,
    getAllReminders,
    deleteReminder,
    cancelReminder,
    createReminderFromText
} from "../controllers/reminder.controller.js";
import User from "../models/user.model.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import { normalizePhoneNumber } from "../utils/phone.js";
import { generateDigest } from "../services/digest.service.js";
import {
  getReminderStats,
  getUpcomingReminders,
  getUserReminders,
} from "../services/reminder.service.js";
const router = express.Router();

router.post("/", createReminder);

router.get("/", getAllReminders);

router.get("/user/:phoneNumber", async (req, res) => {
  try {
    const user = await User.findOne({
      phoneNumber: normalizePhoneNumber(req.params.phoneNumber),
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const reminders = await getUserReminders(user._id);

    res.json(reminders);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
});

router.get("/upcoming/:phoneNumber", async (req, res) => {
  try {
    const user = await User.findOne({
      phoneNumber: normalizePhoneNumber(req.params.phoneNumber),
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const reminders = await getUpcomingReminders(user._id);

    res.json(reminders);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
});

router.get("/stats/:phoneNumber", async (req, res) => {
  try {
    const user = await User.findOne({
      phoneNumber: normalizePhoneNumber(req.params.phoneNumber),
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const stats = await getReminderStats(user._id);

    res.json(stats);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
});

router.delete("/:id", deleteReminder);

router.post("/:id/cancel", cancelReminder);

router.get("/digest/:phoneNumber", async (req, res) => {
  try {
    const user = await User.findOne({
      phoneNumber: normalizePhoneNumber(req.params.phoneNumber),
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