import InboundMessage from "../models/inbound-message.model.js";

export const CLAIM_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Atomically claim an inbound WhatsApp message by its wamid.
 *
 * The unique wamid index is the concurrency mechanism: exactly one caller
 * succeeds, every other caller receives an E11000 and this function returns
 * null. Duplicate arrivals are observed via attemptCount/lastAttemptAt.
 */
export const claimInboundMessage = async ({ wamid, phoneNumber, text }) => {
  try {
    return await InboundMessage.create({
      wamid,
      phoneNumber,
      text,
      status: "received",
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
    });
  } catch (error) {
    if (error.code === 11000) {
      try {
        await InboundMessage.updateOne(
          { wamid },
          { $inc: { attemptCount: 1 }, $set: { lastAttemptAt: new Date() } },
        );
      } catch (observeError) {
        console.error(
          "Failed to record duplicate webhook arrival:",
          observeError.message,
        );
      }

      return null;
    }

    throw error;
  }
};

export const markInboundMessageProcessing = async (id) => {
  await InboundMessage.updateOne(
    { _id: id },
    { $set: { status: "processing", processingStartedAt: new Date() } },
  );
};

export const markInboundMessageProcessed = async (id) => {
  await InboundMessage.updateOne(
    { _id: id },
    { $set: { status: "processed", processedAt: new Date() } },
  );
};

export const markInboundMessageFailed = async (id, error) => {
  await InboundMessage.updateOne(
    { _id: id },
    {
      $set: {
        status: "failed",
        error: error?.message || String(error),
        processedAt: new Date(),
      },
    },
  );
};