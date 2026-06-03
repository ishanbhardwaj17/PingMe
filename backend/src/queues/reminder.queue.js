import { Queue } from "bullmq";
import connection from "../config/redis.js";

const reminderQueue = new Queue("reminders", {
  connection,
});

export default reminderQueue;