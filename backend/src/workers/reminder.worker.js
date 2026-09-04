import { Worker } from "bullmq";
import connection from "../config/redis.js";
import Reminder from "../models/reminder.model.js";
import { advanceRecurrence } from "../services/reminder.service.js";
import { deliverReminder } from "../services/reminder-delivery.service.js";

const worker = new Worker(
  "reminders",
  async (job) => {
    console.log("WORKER TRIGGERED");
    console.log(job.data);

    const { reminderId } = job.data;

    const reminder = await Reminder.findById(reminderId);

    console.log("REMINDER:", reminder);

    if (!reminder) return;

    if (reminder.deliveredAt) {
      console.log(
        `Reminder already delivered (${reminder.deliveredAt.toISOString()}); skipping WhatsApp send.`,
      );
    } else {
      await deliverReminder(reminder, job);
      console.log(`Reminder sent: ${reminder.task}`);
    }

    if (reminder.isRecurring) {
      const successor = await advanceRecurrence(reminder);

      console.log(
        `Next recurring reminder scheduled for ${successor.reminderTime.toISOString()}`,
      );
    }
  },
  {
    connection,
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});
