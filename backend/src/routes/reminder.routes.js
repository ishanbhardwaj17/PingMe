import express from "express";

import {
    createReminder,
    getAllReminders,
    deleteReminder,
} from "../controllers/reminder.controller.js";

const router = express.Router();

router.post("/", createReminder);

router.get("/", getAllReminders);

router.delete("/:id", deleteReminder);

export default router;