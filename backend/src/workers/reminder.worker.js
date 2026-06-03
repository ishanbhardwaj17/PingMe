import { Worker } from "bullmq";
import connection from "../config/redis.js";
import Reminder from "../models/reminder.model.js";
import { createReminder } from "../services/reminder.service.js";

const worker = new Worker(
  "reminders",
  async (job) => {
    const { reminderId } = job.data;

    const reminder = await Reminder.findById(reminderId);

    if (!reminder) return;

    console.log("Reminder Triggered");
    console.log(reminder.task);

    reminder.status = "sent";

    await reminder.save();

    if (reminder.isRecurring) {
      const nextDate = new Date(reminder.reminderTime);

      if (reminder.recurrencePattern === "daily") {
        nextDate.setDate(nextDate.getDate() + 1);
      }

      if (reminder.recurrencePattern === "weekly") {
        nextDate.setDate(nextDate.getDate() + 7);
      }

      if (reminder.recurrencePattern === "monthly") {
        nextDate.setMonth(nextDate.getMonth() + 1);
      }

      await createReminder({
        phoneNumber: reminder.phoneNumber,
        task: reminder.task,
        reminderTime: nextDate,
        isRecurring: true,
        recurrencePattern: reminder.recurrencePattern,
      });
    }
  },
  {
    connection,
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.log(err);
});