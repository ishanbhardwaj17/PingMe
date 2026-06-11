import { findOrCreateUser } from "./user.service.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import { createReminder } from "./reminder.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";

/**
 * Handle incoming message from WhatsApp webhook
 * @param {string} phoneNumber 
 * @param {string} text 
 */
export const handleIncomingMessage = async (phoneNumber, text) => {
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

    return reminder;
  } catch (error) {
    console.error("Error processing incoming message:", error);
    // Send error message to user so they know what went wrong
    try {
      await sendWhatsAppMessage(
        phoneNumber,
        `⚠️ Failed to set reminder: ${error.message || "Invalid format or date/time structure."}`
      );
    } catch (sendError) {
      console.error("Failed to send error message via WhatsApp:", sendError);
    }
    throw error;
  }
};
