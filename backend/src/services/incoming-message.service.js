import { findOrCreateUser } from "./user.service.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import {
  createReminder,
  getUpcomingReminders,
  cancelPendingRemindersForUser,
} from "./reminder.service.js";
import { generateDigest } from "./digest.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";
import {
  classifyMessage,
  INTENTS,
  HELP_TEXT,
  UNKNOWN_TEXT,
} from "./commandRouter.service.js";
import {
  claimInboundMessage,
  markInboundMessageProcessing,
  markInboundMessageProcessed,
  markInboundMessageFailed,
} from "./inbound-message.service.js";

const formatUpcomingReminders = (reminders) => {
  if (reminders.length === 0) {
    return "You have no upcoming reminders.";
  }

  const lines = reminders.map(
    (reminder) =>
      `• ${reminder.task} - ${new Date(reminder.reminderTime).toLocaleTimeString(
        [],
        { hour: "2-digit", minute: "2-digit" },
      )}`,
  );

  return `Upcoming reminders:\n\n${lines.join("\n")}`;
};

/**
 * Handle an incoming WhatsApp message with durable webhook idempotency and
 * deterministic command routing.
 *
 * The wamid is claimed atomically in MongoDB before any processing. A
 * duplicate claim (unique wamid index) skips the pipeline entirely.
 *
 * Routing happens after user resolution and before any parsing: only
 * CREATE_REMINDER executes the reminder creation path; every other intent
 * is dispatched to its existing service.
 *
 * @param {string} wamid - Meta message id
 * @param {string} phoneNumber
 * @param {string} text
 * @param {Function} [sendFn] - outbound sender (injectable for tests)
 */
export const handleIncomingMessage = async (
  wamid,
  phoneNumber,
  text,
  sendFn = sendWhatsAppMessage,
) => {
  const record = await claimInboundMessage({ wamid, phoneNumber, text });

  if (!record) {
    console.log(`Duplicate webhook event skipped: ${wamid}`);
    return null;
  }

  await markInboundMessageProcessing(record._id);

  try {
    const user = await findOrCreateUser(phoneNumber);
    const { intent } = classifyMessage(text);

    switch (intent) {
      case INTENTS.CREATE_REMINDER: {
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
        await sendFn(phoneNumber, confirmationText);

        await markInboundMessageProcessed(record._id);

        return reminder;
      }

      case INTENTS.LIST_REMINDERS: {
        const upcoming = await getUpcomingReminders(user._id);

        await sendFn(phoneNumber, formatUpcomingReminders(upcoming));

        break;
      }

      case INTENTS.SHOW_DIGEST: {
        const digest = await generateDigest(user._id);

        await sendFn(phoneNumber, digest);

        break;
      }

      case INTENTS.DELETE_REMINDER: {
        const cancelledCount = await cancelPendingRemindersForUser(user._id);
        const message =
          cancelledCount > 0
            ? `Cancelled ${cancelledCount} pending reminder(s).`
            : "No pending reminders to cancel.";

        await sendFn(phoneNumber, message);

        break;
      }

      case INTENTS.HELP: {
        await sendFn(phoneNumber, HELP_TEXT);

        break;
      }

      default: {
        // UNKNOWN: friendly response, never a parser attempt.
        await sendFn(phoneNumber, UNKNOWN_TEXT);

        break;
      }
    }

    await markInboundMessageProcessed(record._id);

    return null;
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
      await sendFn(
        phoneNumber,
        `⚠️ Failed to set reminder: ${error.message || "Invalid format or date/time structure."}`,
      );
    } catch (sendError) {
      console.error("Failed to send error message via WhatsApp:", sendError);
    }

    throw error;
  }
};