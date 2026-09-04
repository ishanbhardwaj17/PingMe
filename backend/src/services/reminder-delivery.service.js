import { sendWhatsAppMessage } from "./whatsapp.service.js";
import { UnrecoverableError } from "bullmq";
import Reminder from "../models/reminder.model.js";

export const sendReminder = async (reminder) => {
  return await sendWhatsAppMessage(
    reminder.phoneNumber,
    `⏰ Reminder\n\n${reminder.task}`,
  );
};

/**
 * Extract the outbound message id (wamid) from the WhatsApp API response,
 * when the API provides one. Never manufactured.
 */
export const extractDeliveredMessageId = (result) =>
  result?.messages?.[0]?.id || null;

/**
 * Classify a delivery failure.
 *
 * Permanent: HTTP 4xx from the WhatsApp API (validation failures, invalid
 * recipient, bad token, ...). HTTP 429 and HTTP 5xx are rate limits /
 * server faults and are retryable.
 *
 * Retryable: everything else — network/connection failures, timeouts, and
 * requests that never received an HTTP response (error.response is absent).
 */
export const isPermanentDeliveryError = (error) => {
  const status = error?.response?.status;

  if (typeof status === "number") {
    return status >= 400 && status < 500 && status !== 429;
  }

  return false;
};

/**
 * Execute one delivery attempt for a reminder and persist the outcome.
 *
 * - Increments deliveryAttempts atomically before the actual send attempt.
 * - On success: status = sent, deliveredAt, deliveredMessageId (if the API
 *   returns one), lastError cleared.
 * - On permanent failure: status = failed, lastError stored, and an
 *   UnrecoverableError is thrown so BullMQ fails the job without further
 *   attempts (retry decisions are made inside BullMQ's moveToFailed).
 * - On retryable failure: lastError stored; the original error is rethrown
 *   so BullMQ applies the configured retry/backoff. After the final attempt
 *   the reminder is marked failed.
 *
 * Note: exactly-once outbound delivery is not guaranteed — a process crash
 * between the WhatsApp API accepting a message and MongoDB recording
 * success can cause a retry to re-send. This is an accepted, documented
 * limitation of the at-least-once model.
 */
export const deliverReminder = async (
  reminder,
  job,
  sendFn = sendReminder,
) => {
  // Already-delivered guard: a retried job after the deliveredAt state was
  // durably persisted must not send another WhatsApp message. Note this
  // does NOT provide exactly-once delivery for the crash window before
  // deliveredAt is persisted (Meta may have accepted the message while the
  // process died before the DB write).
  if (reminder.deliveredAt) {
    return { success: true, alreadyDelivered: true };
  }

  await Reminder.updateOne(
    { _id: reminder._id },
    { $inc: { deliveryAttempts: 1 } },
  );

  let result;

  try {
    result = await sendFn(reminder);
  } catch (error) {
    const errorMessage = error?.message || "Unknown delivery error";

    if (isPermanentDeliveryError(error)) {
      await Reminder.updateOne(
        { _id: reminder._id },
        { $set: { status: "failed", lastError: errorMessage } },
      );

      console.error("Permanent delivery failure:", errorMessage);

      throw new UnrecoverableError(errorMessage);
    }

    const maxAttempts = job.opts.attempts ?? 1;

    if (job.attemptsMade + 1 >= maxAttempts) {
      await Reminder.updateOne(
        { _id: reminder._id },
        { $set: { status: "failed", lastError: errorMessage } },
      );
    } else {
      await Reminder.updateOne(
        { _id: reminder._id },
        { $set: { lastError: errorMessage } },
      );
    }

    throw error;
  }

  await Reminder.updateOne(
    { _id: reminder._id },
    {
      $set: {
        status: "sent",
        deliveredAt: new Date(),
        deliveredMessageId: extractDeliveredMessageId(result),
        lastError: null,
      },
    },
  );

  return { success: true };
};