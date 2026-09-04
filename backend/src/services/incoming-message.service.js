import { findOrCreateUser } from "./user.service.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import { createReminder } from "./reminder.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";
import {
  claimInboundMessage,
  markInboundMessageProcessing,
  markInboundMessageProcessed,
  markInboundMessageFailed,
} from "./inbound-message.service.js";

/**
 * Handle an incoming WhatsApp message with durable webhook idempotency.
 *
 * The wamid is claimed atomically in MongoDB before any processing. A
 * duplicate claim (unique wamid index) skips the pipeline entirely.
 *
 * @param {string} wamid - Meta message id
 * @param {string} phoneNumber
 * @param {string} text
 */
export const handleIncomingMessage = async (wamid, phoneNumber, text) => {
  const record = await claimInboundMessage({ wamid, phoneNumber, text });

  if (!record) {
    console.log(`Duplicate webhook event skipped: ${wamid}`);
    return null;
  }

  await markInboundMessageProcessing(record._id);

  try {
    const user = await findOrCreateUser(phoneNumber);
    const parsed = parseReminderText(text);
    const recurrencePattern = detectRecurrence(text);
    const isRecurring = recurrencePattern !== null;

    const reminder = await createReminder({
      phoneNumber,
      task: parsed.task,
      reminderTime: parsed.reminderTime,
      userId: user._id,
      isRecurring,
      recurrencePattern,
    });

    // Send confirmation back to WhatsApp
    const confirmationText = `✅ Reminder set\n\n${parsed.task}`;
    await sendWhatsAppMessage(phoneNumber, confirmationText);

    await markInboundMessageProcessed(record._id);

    return reminder;
  } catch (error) {
    console.error("Error processing incoming message:", error);

    try {
      await markInboundMessageFailed(record._id, error);
    } catch (markError) {
      console.error(
        "Failed to mark inbound message as failed:",
        markError.message,
      );
    }

    // Send error message to user so they know what went wrong
    try {
      await sendWhatsAppMessage(
        phoneNumber,
        `⚠️ Failed to set reminder: ${error.message || "Invalid format or date/time structure."}`,
      );
    } catch (sendError) {
      console.error("Failed to send error message via WhatsApp:", sendError);
    }

    throw error;
  }
};