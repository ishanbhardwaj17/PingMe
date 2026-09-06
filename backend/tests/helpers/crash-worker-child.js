import "dotenv/config";
import mongoose from "mongoose";
import { Worker } from "bullmq";
import Reminder from "../../src/models/reminder.model.js";
import { deliverReminder } from "../../src/services/reminder-delivery.service.js";
import { advanceRecurrence } from "../../src/services/reminder.service.js";

const mode = process.env.CRASH_MODE;
const queueName = process.env.CRASH_QUEUE;
const sendLog = process.env.CRASH_SEND_LOG;

const logSend = async (reminder) => {
  if (sendLog) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(sendLog, `SEND ${reminder.task}\n`);
  }

  return { messaging_product: "whatsapp", messages: [{ id: "wamid.crash.child" }] };
};

const hang = () => new Promise(() => {});

await mongoose.connect(process.env.MONGO_URI);

const processor = async (job) => {
  const reminder = await Reminder.findById(job.data.reminderId);

  if (!reminder) return;

  if (mode === "send-then-crash") {
    // The external side effect (WhatsApp acceptance) happens, but the
    // process dies before MongoDB delivery state is persisted.
    await logSend(reminder);
    await hang();
    return;
  }

  if (mode === "deliver-then-crash") {
    await deliverReminder(reminder, job, logSend);
    await hang();
    return;
  }

  await deliverReminder(reminder, job, logSend);

  if (reminder.isRecurring) {
    await advanceRecurrence(reminder);
  }
};

const worker = new Worker(
  queueName,
  processor,
  {
    connection: { host: "127.0.0.1", port: 6379 },
    lockDuration: 1000,
    // Short so the child's stalled-check key (PX = stalledInterval) expires
    // quickly after the child is killed; a long default (30000) would block
    // the recovery worker's stalled checks for up to 30 seconds.
    stalledInterval: 500,
  },
);

process.stdout.write("READY\n");
process.stdout.write(`CRASH_CHILD_STARTED mode=${mode}\n`);