import { Worker } from "bullmq";
import connection from "../config/redis.js";

const worker = new Worker(
  "reminders",
  async (job) => {
    console.log("================================");
    console.log("REMINDER TRIGGERED");
    console.log(job.data);
    console.log("================================");
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