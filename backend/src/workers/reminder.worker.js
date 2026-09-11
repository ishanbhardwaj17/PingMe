import { Worker } from "bullmq";
import connection from "../config/redis.js";
import Reminder from "../models/reminder.model.js";
import { advanceRecurrence } from "../services/reminder.service.js";
import { runStrandRecoveryPass } from "../services/reminder.service.js";
import { deliverReminder } from "../services/reminder-delivery.service.js";
import { runDigestSchedulerPass } from "../services/digest.service.js";

const STRAND_RECOVERY_INTERVAL_MS = 60_000;
const STRAND_RECOVERY_AGE_MS = 120_000;
const DIGEST_INTERVAL_MS = 60_000;

const tickStrandRecovery = async () => {
  try {
    const result = await runStrandRecoveryPass({
      olderThanMs: STRAND_RECOVERY_AGE_MS,
    });

    if (result.detected > 0) {
      console.log(
        `Strand recovery: detected ${result.detected}, recovered ${result.recovered}`,
      );
    }
  } catch (error) {
    console.error("Strand recovery pass failed:", error.message);
  }
};

const tickDigests = async () => {
  try {
    const sent = await runDigestSchedulerPass();

    if (sent > 0) {
      console.log(`Morning digest: sent ${sent}`);
    }
  } catch (error) {
    console.error("Digest scheduler pass failed:", error.message);
  }
};

// Immediate first pass, then periodic recovery while this process runs.
tickStrandRecovery();
setInterval(tickStrandRecovery, STRAND_RECOVERY_INTERVAL_MS);

tickDigests();
setInterval(tickDigests, DIGEST_INTERVAL_MS);

const worker = new Worker(
  "reminders",
  async (job) => {
    console.log("WORKER TRIGGERED");
    console.log(job.data);

    const { reminderId } = job.data;

    const reminder = await Reminder.findById(reminderId);

    console.log("REMINDER:", reminder);

    if (!reminder) return;

    if (reminder.status === "cancelled" || reminder.status === "failed") {
      console.log(
        `Reminder ${reminder.status} (${reminder._id}); skipping execution.`,
      );
      return;
    }

    if (reminder.deliveredAt) {
      console.log(
        `Reminder already delivered (${reminder.deliveredAt.toISOString()}); skipping WhatsApp send.`,
      );
    } else {
      const outcome = await deliverReminder(reminder, job);

      if (outcome.skipped) {
        console.log(
          `Reminder no longer pending (${outcome.status}); skipping execution.`,
        );
        return;
      }

      console.log(`Reminder sent: ${reminder.task}`);
    }

    if (reminder.isRecurring) {
      const successor = await advanceRecurrence(reminder);

      if (!successor) {
        console.log(
          `Parent ${reminder._id} no longer exists; recurrence not advanced.`,
        );
        return;
      }

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
