import { Worker } from "bullmq";
import connection from "../config/redis.js";
import Reminder from "../models/reminder.model.js";

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