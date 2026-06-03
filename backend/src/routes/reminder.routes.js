import express from "express";

import {
    createReminder,
    getAllReminders,
    deleteReminder,
} from "../controllers/reminder.controller.js";
import reminderQueue from "../queues/reminder.queue.js";

const router = express.Router();

router.post("/", createReminder);

router.post("/test-job", async (req, res) => {
  await reminderQueue.add(
    "send-reminder",
    {
      task: "BullMQ Working",
    },
    {
      delay: 10000,
    }
  );

  res.json({
    success: true,
    message: "Job scheduled",
  });
});

router.get("/", getAllReminders);

router.delete("/:id", deleteReminder);

export default router;