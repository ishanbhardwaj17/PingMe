import { findOrCreateUser } from "./user.service.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import {
  createReminder,
  getUpcomingReminders,
  getReminderByNumberForUser,
  cancelPendingRemindersForUser,
  cancelReminder,
  updateReminder,
} from "./reminder.service.js";
import { generateDigest } from "./digest.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";
import {
  classifyMessage,
  INTENTS,
  HELP_TEXT,
  UNKNOWN_TEXT,
  parseNumberedDelete,
  parseNumberedEdit,
  parseNumberedSnooze,
} from "./commandRouter.service.js";
import {
  claimInboundMessage,
  markInboundMessageProcessing,
  markInboundMessageProcessed,
  markInboundMessageFailed,
} from "./inbound-message.service.js";
import { aiInterpretMessage } from "./ai-assistant.service.js";

const formatTime = (date) =>
  new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

const formatUpcomingReminders = (reminders) => {
  if (reminders.length === 0) {
    return "You have no upcoming reminders.";
  }

  const lines = reminders.map(
    (reminder, index) => `${index + 1}. ${reminder.task} - ${formatTime(reminder.reminderTime)}`,
  );

  return `Upcoming reminders:\n\n${lines.join("\n")}`;
};

/**
 * Execute a validated AI create_reminder action through the existing
 * deterministic creation path.
 *
 * @returns {Promise<object|null>} the created reminder or null (a response
 *   has already been sent in that case)
 */
const handleAiCreate = async (action, phoneNumber, userId, sendFn) => {
  let parsed;

  try {
    parsed = parseReminderText(`Remind me to ${action.task} ${action.when}`);
  } catch {
    await sendFn(phoneNumber, UNKNOWN_TEXT);
    return null;
  }

  const recurrencePattern =
    action.recurrence === "none" ? null : action.recurrence;

  const reminder = await createReminder({
    phoneNumber,
    task: parsed.task,
    reminderTime: parsed.reminderTime,
    userId,
    isRecurring: recurrencePattern !== null,
    recurrencePattern,
  });

  await sendFn(phoneNumber, `✅ Reminder set\n\n${parsed.task}`);

  return reminder;
};

/**
 * Execute a validated AI edit_reminder action.
 *
 * The model's target number is re-resolved fresh at execution time, and the
 * targetTask echo is verified against the freshly fetched reminder before
 * any mutation. Time is resolved exclusively by the existing chrono-based
 * parser; the past-time and "never move earlier" guards run before
 * updateReminder, which is the only mutation (no create, no manual BullMQ).
 *
 * @returns {Promise<object|null>} the updated reminder or null (a response
 *   has already been sent in that case)
 */
const handleAiEdit = async (action, phoneNumber, userId, sendFn) => {
  const selected = await getReminderByNumberForUser(userId, action.target);

  if (!selected) {
    await sendFn(
      phoneNumber,
      `I couldn't find that reminder.\n\n${formatUpcomingReminders(
        await getUpcomingReminders(userId),
      )}`,
    );
    return null;
  }

  if (selected.task.toLowerCase() !== action.targetTask.toLowerCase()) {
    await sendFn(
      phoneNumber,
      `Which reminder did you mean?\n\n${formatUpcomingReminders(
        await getUpcomingReminders(userId),
      )}`,
    );
    return null;
  }

  const finalTask = action.task ?? selected.task;
  let finalReminderTime = selected.reminderTime;

  if (action.when) {
    let parsed;

    try {
      parsed = parseReminderText(
        `Remind me to ${finalTask} ${action.when}`,
      );
    } catch {
      await sendFn(
        phoneNumber,
        "Sorry, I couldn't understand the new time.",
      );
      return null;
    }

    const newTime = parsed.reminderTime;

    if (newTime.getTime() <= Date.now()) {
      await sendFn(
        phoneNumber,
        "The new time is in the past. Please choose a future time.",
      );
      return null;
    }

    if (newTime.getTime() <= selected.reminderTime.getTime()) {
      await sendFn(
        phoneNumber,
        "You can only move a reminder to a later time.",
      );
      return null;
    }

    finalReminderTime = newTime;
  }

  const updated = await updateReminder(selected._id, {
    task: finalTask,
    reminderTime: finalReminderTime,
  });

  if (!updated) {
    await sendFn(phoneNumber, "This reminder can no longer be edited.");
    return null;
  }

  await sendFn(
    phoneNumber,
    `Updated reminder ${action.target}: ${updated.task} - ${formatTime(updated.reminderTime)}`,
  );

  return updated;
};

/**
 * Execute a validated AI delete_reminder action.
 *
 * The model's target number is re-resolved fresh at execution time, and the
 * targetTask echo is verified against the freshly fetched reminder before
 * any mutation. Only the existing cancelReminder() is used for the
 * cancellation; any resolution failure yields a deterministic response with
 * zero reminder or queue mutation.
 *
 * @returns {Promise<object|null>} the cancelled reminder or null (a response
 *   has already been sent in that case)
 */
const handleAiDelete = async (action, phoneNumber, userId, sendFn) => {
  const selected = await getReminderByNumberForUser(userId, action.target);

  if (!selected) {
    await sendFn(
      phoneNumber,
      `I couldn't find that reminder.\n\n${formatUpcomingReminders(
        await getUpcomingReminders(userId),
      )}`,
    );
    return null;
  }

  if (selected.task.toLowerCase() !== action.targetTask.toLowerCase()) {
    await sendFn(
      phoneNumber,
      `Which reminder did you mean?\n\n${formatUpcomingReminders(
        await getUpcomingReminders(userId),
      )}`,
    );
    return null;
  }

  const cancelled = await cancelReminder(selected._id);

  if (!cancelled || cancelled.status !== "cancelled") {
    await sendFn(phoneNumber, "This reminder can no longer be deleted.");
    return null;
  }

  await sendFn(
    phoneNumber,
    `Cancelled reminder ${action.target}: ${cancelled.task}`,
  );

  return cancelled;
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
 * @param {Function} [aiInterpret] - AI interpretation seam (injectable for
 *   tests); only reached from the UNKNOWN intent
 */
export const handleIncomingMessage = async (
  wamid,
  phoneNumber,
  text,
  sendFn = sendWhatsAppMessage,
  aiInterpret = aiInterpretMessage,
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
        const numbered = parseNumberedDelete(text);

        if (numbered) {
          const selected = await getReminderByNumberForUser(
            user._id,
            numbered.number,
          );

          if (!selected) {
            await sendFn(
              phoneNumber,
              `Sorry, I couldn't find reminder ${numbered.number}.`,
            );
            break;
          }

          await cancelReminder(selected._id);

          await sendFn(
            phoneNumber,
            `Cancelled reminder ${numbered.number}: ${selected.task}`,
          );

          break;
        }

        const cancelledCount = await cancelPendingRemindersForUser(user._id);
        const message =
          cancelledCount > 0
            ? `Cancelled ${cancelledCount} pending reminder(s).`
            : "No pending reminders to cancel.";

        await sendFn(phoneNumber, message);

        break;
      }

      case INTENTS.EDIT_REMINDER: {
        const parsed = parseNumberedEdit(text);

        if (!parsed) {
          await sendFn(phoneNumber, UNKNOWN_TEXT);
          break;
        }

        const selected = await getReminderByNumberForUser(
          user._id,
          parsed.number,
        );

        if (!selected) {
          await sendFn(
            phoneNumber,
            `Sorry, I couldn't find reminder ${parsed.number}.`,
          );
          break;
        }

        let newReminder;

        try {
          newReminder = parseReminderText(parsed.remainder);
        } catch {
          await sendFn(
            phoneNumber,
            "Sorry, I couldn't understand the new reminder text. Please try:\nedit reminder 1 to <task> tomorrow at 8 PM",
          );
          break;
        }

        if (new Date(newReminder.reminderTime).getTime() <= Date.now()) {
          await sendFn(
            phoneNumber,
            "The new reminder time is in the past. Please provide a future time.",
          );
          break;
        }

        const updated = await updateReminder(selected._id, {
          task: newReminder.task,
          reminderTime: newReminder.reminderTime,
        });

        if (!updated) {
          await sendFn(
            phoneNumber,
            `Sorry, reminder ${parsed.number} can no longer be edited.`,
          );
          break;
        }

        await sendFn(
          phoneNumber,
          `Updated reminder ${parsed.number}: ${updated.task} - ${formatTime(updated.reminderTime)}`,
        );

        break;
      }

      case INTENTS.SNOOZE_REMINDER: {
        const parsed = parseNumberedSnooze(text);

        if (!parsed) {
          await sendFn(phoneNumber, UNKNOWN_TEXT);
          break;
        }

        const selected = await getReminderByNumberForUser(
          user._id,
          parsed.number,
        );

        if (!selected) {
          await sendFn(
            phoneNumber,
            `Sorry, I couldn't find reminder ${parsed.number}.`,
          );
          break;
        }

        let snoozeTarget;

        try {
          snoozeTarget = parseReminderText(parsed.remainder);
        } catch {
          await sendFn(
            phoneNumber,
            "Sorry, I couldn't understand the snooze time. Please try:\nsnooze reminder 1 for 30 minutes",
          );
          break;
        }

        const newReminderTime = new Date(snoozeTarget.reminderTime);
        const currentReminderTime = new Date(selected.reminderTime);

        if (newReminderTime.getTime() <= Date.now()) {
          await sendFn(
            phoneNumber,
            "The snooze time is in the past. Please provide a future time.",
          );
          break;
        }

        if (newReminderTime.getTime() <= currentReminderTime.getTime()) {
          await sendFn(
            phoneNumber,
            "Snooze can only move a reminder to a later time.",
          );
          break;
        }

        const updated = await updateReminder(selected._id, {
          task: selected.task,
          reminderTime: newReminderTime,
        });

        if (!updated) {
          await sendFn(
            phoneNumber,
            `Sorry, reminder ${parsed.number} can no longer be snoozed.`,
          );
          break;
        }

        await sendFn(
          phoneNumber,
          `Snoozed reminder ${parsed.number}: ${updated.task} - ${formatTime(updated.reminderTime)}`,
        );

        break;
      }

      case INTENTS.HELP: {
        await sendFn(phoneNumber, HELP_TEXT);

        break;
      }

      default: {
        // UNKNOWN: only this path may invoke the AI interpretation layer.
        // Fail-closed: any AI failure (provider error, timeout, malformed
        // output, invalid action) yields the friendly response and no
        // reminder or job is created or modified.
        let action;

        try {
          action = await aiInterpret(text, {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            reminders: await getUpcomingReminders(user._id),
          });
        } catch (error) {
          console.error("[ai] interpretation failed:", error.message);
          await sendFn(phoneNumber, UNKNOWN_TEXT);
          break;
        }

        if (!action) {
          await sendFn(phoneNumber, UNKNOWN_TEXT);
          break;
        }

        if (action.action === "create_reminder") {
          const reminder = await handleAiCreate(action, phoneNumber, user._id, sendFn);

          if (reminder) {
            await markInboundMessageProcessed(record._id);
            return reminder;
          }

          break;
        }

        if (action.action === "edit_reminder") {
          const updated = await handleAiEdit(action, phoneNumber, user._id, sendFn);

          if (updated) {
            await markInboundMessageProcessed(record._id);
            return updated;
          }

          break;
        }

        if (action.action === "delete_reminder") {
          const cancelled = await handleAiDelete(action, phoneNumber, user._id, sendFn);

          if (cancelled) {
            await markInboundMessageProcessed(record._id);
            return cancelled;
          }

          break;
        }

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