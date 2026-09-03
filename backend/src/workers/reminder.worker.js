import { Worker } from "bullmq";
import connection from "../config/redis.js";
import Reminder from "../models/reminder.model.js";
import { createReminder } from "../services/reminder.service.js";
import { sendReminder } from "../services/reminder-delivery.service.js";
import { nextOccurrence } from "../utils/recurrenceParser.js";

const worker = new Worker(
  "reminders",
  async (job) => {
    console.log("WORKER TRIGGERED");
    console.log(job.data);

    const { reminderId } = job.data;

    const reminder = await Reminder.findById(reminderId);

    console.log("REMINDER:", reminder);

    if (!reminder) return;

    try {
      await sendReminder(reminder);

      reminder.status = "sent";
      await reminder.save();

      console.log(`Reminder sent: ${reminder.task}`);
    } catch (error) {
      reminder.status = "failed";
      await reminder.save();

      console.error("Failed to send reminder:", error.message);

      throw error;
    }

    if (reminder.isRecurring) {
      const nextDate = nextOccurrence(
        reminder.reminderTime,
        reminder.recurrencePattern,
        reminder.recurrenceAnchorDay,
      );

      await createReminder({
        phoneNumber: reminder.phoneNumber,
        task: reminder.task,
        reminderTime: nextDate,
        isRecurring: true,
        recurrencePattern: reminder.recurrencePattern,
        recurrenceAnchorDay: reminder.recurrenceAnchorDay,
        userId: reminder.userId,
      });

      console.log(
        `Next recurring reminder scheduled for ${nextDate.toISOString()}`,
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
