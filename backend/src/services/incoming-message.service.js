import { resolveUser, setUserTimezone, setDigestEnabled } from "./user.service.js";
import { parseReminderText } from "../utils/parser.js";
import { detectRecurrence } from "../utils/recurrenceParser.js";
import {
  createReminder,
  getUpcomingReminders,
  getReminderByNumberForUser,
  getRemindersInTimeRange,
  getLatestDeliveredReminder,
  cancelPendingRemindersForUser,
  cancelReminder,
  updateReminder,
  stopRecurringReminder,
} from "./reminder.service.js";
import { generateDigest } from "./digest.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";
import {
  classifyMessage,
  INTENTS,
  HELP_TEXT,
  UNKNOWN_TEXT,
  WELCOME_TEXT,
  parseNumberedDelete,
  parseNumberedEdit,
  parseNumberedSnooze,
  parseNumberedStop,
  parseTimezoneCommand,
} from "./commandRouter.service.js";
import {
  claimInboundMessage,
  markInboundMessageProcessing,
  markInboundMessageProcessed,
  markInboundMessageFailed,
} from "./inbound-message.service.js";
import { aiInterpretMessage } from "./ai-assistant.service.js";
import { resolveRange } from "../utils/timeRange.js";
import {
  formatReminderTimeLabel,
  formatRecurrenceNote,
} from "../utils/messageFormat.js";
import { zonedFormatTime, zonedDayParts, zonedLocalTimeInstant } from "../utils/timezone.js";

const formatTime = (date, timezone) =>
  timezone
    ? zonedFormatTime(date, timezone)
    : new Date(date).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

const formatUpcomingReminders = (reminders, timezone) => {
  if (reminders.length === 0) {
    return "You have no upcoming reminders.";
  }

  const lines = reminders.map((reminder, index) => {
    const recurrenceNote = formatRecurrenceNote(reminder.recurrencePattern);

    return `${index + 1}. ${reminder.task} - ${formatTime(reminder.reminderTime, timezone)}${
      recurrenceNote ? ` (${recurrenceNote})` : ""
    }`;
  });

  return `Upcoming reminders:\n\n${lines.join("\n")}`;
};

/**
 * Execute a validated AI create_reminder action through the existing
 * deterministic creation path.
 *
 * @returns {Promise<object|null>} the created reminder or null (a response
 *   has already been sent in that case)
 */
const handleAiCreate = async (action, phoneNumber, userId, sendFn, timezone) => {
  let parsed;

  try {
    parsed = parseReminderText(
      `Remind me to ${action.task} ${action.when}`,
      timezone,
    );
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
    timezone,
  });

  await sendFn(
    phoneNumber,
    buildConfirmation(
      reminder.task,
      reminder.reminderTime,
      recurrencePattern,
      timezone,
    ),
  );

  return reminder;
};

const buildConfirmation = (task, reminderTime, recurrencePattern, timezone) => {
  const lines = [
    "✅ Reminder set",
    "",
    task,
    "",
    `🕐 ${formatReminderTimeLabel(reminderTime, timezone)}`,
  ];

  const recurrenceNote = formatRecurrenceNote(recurrencePattern);

  if (recurrenceNote) {
    lines.push(`🔁 ${recurrenceNote}`);
  }

  return lines.join("\n");
};

/**
 * Acknowledge "done" against the user's most recently delivered reminder.
 * Acknowledgement only: no mutation, no status change, no new reminder.
 *
 * @returns {Promise<boolean>} true when a response was sent
 */
const handlePostDeliveryDone = async (phoneNumber, userId, sendFn) => {
  const latest = await getLatestDeliveredReminder(userId);

  if (!latest) {
    await sendFn(
      phoneNumber,
      "I do not have a recent delivered reminder to mark done.",
    );
    return false;
  }

  await sendFn(phoneNumber, "Done! ✔️");

  return true;
};

/**
 * Create a follow-up reminder for the user's most recently delivered
 * reminder, preserving the original task exactly. The target phrase is
 * parsed by the existing chrono-based parser; the new time is relative to
 * now (e.g. "snooze 30 minutes"). The delivered reminder is never modified.
 *
 * @returns {Promise<object|null>} the new reminder or null (a response has
 *   already been sent in that case)
 */
const handlePostDeliverySnooze = async (text, phoneNumber, userId, sendFn, timezone) => {
  const latest = await getLatestDeliveredReminder(userId);

  if (!latest) {
    await sendFn(
      phoneNumber,
      "I do not have a recent delivered reminder to snooze.",
    );
    return null;
  }

  const target = text.replace(/^snooze(?:\s+for)?\s*/i, "").trim();

  // Bare durations ("snooze 30 minutes") need a connector for chrono;
  // phrases that already carry one ("until tomorrow") are used as-is.
  const phrase = /^(?:for|in|until|at|on|by)\b/i.test(target)
    ? target
    : `in ${target}`;

  return createFollowUpReminder(latest, phrase, phoneNumber, userId, sendFn, timezone);
};

/**
 * Create a follow-up reminder for the user's most recently delivered
 * reminder for "remind me again <when>". For date-only phrases ("tomorrow",
 * "next Monday") the original reminder's time-of-day is preserved; explicit
 * times ("at 9 PM", "in 30 minutes") resolve as stated.
 *
 * @returns {Promise<object|null>} the new reminder or null (a response has
 *   already been sent in that case)
 */
const handlePostDeliveryRemindAgain = async (
  text,
  phoneNumber,
  userId,
  sendFn,
  timezone,
) => {
  const latest = await getLatestDeliveredReminder(userId);

  if (!latest) {
    await sendFn(
      phoneNumber,
      "I do not have a recent delivered reminder to remind again.",
    );
    return null;
  }

  const target = text.replace(/^remind me again\b/i, "").trim();

  if (!target) {
    await sendFn(
      phoneNumber,
      "When should I remind you again?\nTry:\nremind me again tomorrow",
    );
    return null;
  }

  const reminder = await createFollowUpReminder(
    latest,
    target,
    phoneNumber,
    userId,
    sendFn,
    timezone,
    { preserveTimeOfDay: true },
  );

  return reminder;
};

/**
 * Shared follow-up creation for post-delivery actions.
 *
 * The delivered reminder is never modified: a NEW reminder is created
 * through the existing createReminder path (task preserved exactly, time
 * resolved by chrono, BullMQ scheduling centralized).
 *
 * @param {object} latest - the latest delivered reminder (task source)
 * @param {string} target - the natural-language time phrase
 * @param {boolean} [preserveTimeOfDay] - for date-only phrases, reuse the
 *   delivered reminder's local time-of-day instead of the current clock time
 * @returns {Promise<object|null>} the new reminder or null (a response has
 *   already been sent in that case)
 */
const createFollowUpReminder = async (
  latest,
  target,
  phoneNumber,
  userId,
  sendFn,
  timezone,
  { preserveTimeOfDay = false } = {},
) => {
  let parsed;

  try {
    parsed = parseReminderText(
      `Remind me to ${latest.task} ${target}`,
      timezone,
    );
  } catch {
    await sendFn(phoneNumber, "Sorry, I couldn't understand that time.");
    return null;
  }

  let newTime = new Date(parsed.reminderTime);

  if (preserveTimeOfDay && !parsed.hourSpecified) {
    // Tomorrow (or the parsed date) at the delivered reminder's local
    // time-of-day in the user's timezone.
    const parts = zonedDayParts(latest.reminderTime, timezone);
    const targetParts = zonedDayParts(newTime, timezone);

    newTime = zonedLocalTimeInstant(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      parts.hour,
      parts.minute,
      timezone,
    );
  }

  if (newTime.getTime() <= Date.now()) {
    await sendFn(
      phoneNumber,
      "That time is in the past. Please choose a future time.",
    );
    return null;
  }

  const reminder = await createReminder({
    phoneNumber,
    task: latest.task,
    reminderTime: newTime,
    userId,
    timezone,
  });

  await sendFn(
    phoneNumber,
    buildConfirmation(latest.task, reminder.reminderTime, null, timezone),
  );

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
const handleAiEdit = async (action, phoneNumber, userId, sendFn, timezone) => {
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
        timezone,
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
    `Updated reminder ${action.target}: ${updated.task} - ${formatTime(updated.reminderTime, timezone)}`,
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
const handleAiDelete = async (action, phoneNumber, userId, sendFn, timezone) => {
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
 * Format and send a temporal-range reminder list ("Reminders for today:"
 * style), shared by the AI temporal action and the deterministic today
 * query. Resolves the range in the user's timezone.
 */
const sendRangeList = async (
  phoneNumber,
  userId,
  timezone,
  sendFn,
  range,
  datePhrase,
) => {
  const resolved = resolveRange(range, datePhrase, new Date(), timezone);

  if (!resolved) {
    await sendFn(phoneNumber, "Sorry, I couldn't understand that date.");
    return;
  }

  const reminders = await getRemindersInTimeRange(
    userId,
    resolved.start,
    resolved.end,
  );

  if (reminders.length === 0) {
    await sendFn(phoneNumber, `No reminders for ${resolved.label}. 🎉`);
    return;
  }

  const lines = reminders.map(
    (reminder, index) =>
      `${index + 1}. ${reminder.task} - ${formatTime(reminder.reminderTime, timezone)}`,
  );

  await sendFn(
    phoneNumber,
    `Reminders for ${resolved.label}:\n\n${lines.join("\n")}`,
  );
};

/**
 * Execute a validated AI list_reminders action.
 *
 * Read-only: the AI expresses only the temporal intent; the server resolves
 * the boundaries (resolveRange), performs the user-scoped range query, and
 * formats the result. "next_reminder" selects the earliest selectable
 * reminder via the existing getUpcomingReminders.
 *
 * @returns {Promise<boolean>} always true (a response has been sent)
 */
const handleAiList = async (action, phoneNumber, userId, sendFn, timezone) => {
  if (action.range === "next_reminder") {
    const upcoming = await getUpcomingReminders(userId);

    if (upcoming.length === 0) {
      await sendFn(phoneNumber, "You have no upcoming reminders.");
      return true;
    }

    const next = upcoming[0];

    await sendFn(
      phoneNumber,
      `Next reminder:\n\n1. ${next.task} - ${formatTime(next.reminderTime, timezone)}`,
    );

    return true;
  }

  await sendRangeList(
    phoneNumber,
    userId,
    timezone,
    sendFn,
    action.range,
    action.date,
  );

  return true;
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
    const { user, isNew } = await resolveUser(phoneNumber);

    // First contact: welcome the user once, then process their message
    // normally. Duplicate wamids never reach this point (the claim above
    // already skipped them).
    if (isNew) {
      await sendFn(phoneNumber, WELCOME_TEXT);
    }

    const { intent } = classifyMessage(text);

    const timezone = user.timezone || null;

    switch (intent) {
      case INTENTS.CREATE_REMINDER: {
        const parsed = parseReminderText(text, timezone);
        const recurrencePattern = detectRecurrence(text);
        const isRecurring = recurrencePattern !== null;

        const reminder = await createReminder({
          phoneNumber,
          task: parsed.task,
          reminderTime: parsed.reminderTime,
          userId: user._id,
          isRecurring,
          recurrencePattern,
          timezone,
        });

        // Send confirmation back to WhatsApp
        await sendFn(
          phoneNumber,
          buildConfirmation(
            reminder.task,
            reminder.reminderTime,
            recurrencePattern,
            timezone,
          ),
        );

        await markInboundMessageProcessed(record._id);

        return reminder;
      }

      case INTENTS.LIST_REMINDERS: {
        const upcoming = await getUpcomingReminders(user._id);

        await sendFn(phoneNumber, formatUpcomingReminders(upcoming, timezone));

        break;
      }

      case INTENTS.LIST_TODAY: {
        await sendRangeList(
          phoneNumber,
          user._id,
          timezone,
          sendFn,
          "today",
          undefined,
        );

        break;
      }

      case INTENTS.SHOW_DIGEST: {
        const digest = await generateDigest(user._id, timezone);

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
          newReminder = parseReminderText(parsed.remainder, timezone);
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
        // A time-only edit ("edit reminder 1 to tomorrow at 5 PM") parses to
        // an empty task: preserve the existing task instead of erasing it.
        task: newReminder.task || selected.task,
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
          `Updated reminder ${parsed.number}: ${updated.task} - ${formatTime(updated.reminderTime, timezone)}`,
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
          snoozeTarget = parseReminderText(parsed.remainder, timezone);
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
          `Snoozed reminder ${parsed.number}: ${updated.task} - ${formatTime(updated.reminderTime, timezone)}`,
        );

        break;
      }

      case INTENTS.STOP_RECURRING: {
        const parsed = parseNumberedStop(text);

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

        if (!selected.isRecurring) {
          await sendFn(
            phoneNumber,
            `Reminder ${parsed.number} is not recurring. Use delete reminder ${parsed.number} to cancel it.`,
          );
          break;
        }

        const stopped = await stopRecurringReminder(selected._id);

        if (!stopped) {
          await sendFn(
            phoneNumber,
            `Reminder ${parsed.number} can no longer be stopped.`,
          );
          break;
        }

        await sendFn(
          phoneNumber,
          `🛑 Recurring reminder stopped\n\n${selected.task}\n\nNo future reminders will be created.`,
        );

        break;
      }

      case INTENTS.POST_DELIVERY_DONE: {
        await handlePostDeliveryDone(phoneNumber, user._id, sendFn);

        break;
      }

      case INTENTS.POST_DELIVERY_SNOOZE: {
        const followUp = await handlePostDeliverySnooze(
          text,
          phoneNumber,
          user._id,
          sendFn,
          timezone,
        );

        if (followUp) {
          await markInboundMessageProcessed(record._id);
          return followUp;
        }

        break;
      }

      case INTENTS.POST_DELIVERY_REMIND_AGAIN: {
        const followUp = await handlePostDeliveryRemindAgain(
          text,
          phoneNumber,
          user._id,
          sendFn,
          timezone,
        );

        if (followUp) {
          await markInboundMessageProcessed(record._id);
          return followUp;
        }

        break;
      }

      case INTENTS.SET_TIMEZONE: {
        const parsed = parseTimezoneCommand(text);

        if (!parsed) {
          await sendFn(phoneNumber, UNKNOWN_TEXT);
          break;
        }

        const result = await setUserTimezone(user._id, parsed.timezone);

        if (!result.updated) {
          await sendFn(
            phoneNumber,
            "That timezone is not valid. Use an IANA timezone such as Asia/Kolkata or America/New_York.",
          );
          break;
        }

        await sendFn(
          phoneNumber,
          `🌎 Timezone updated\n\n${result.timezone}\n\nExisting reminders keep their scheduled times; future reminders use your new timezone.`,
        );

        break;
      }

      case INTENTS.ENABLE_DIGEST: {
        await setDigestEnabled(user._id, true);

        await sendFn(
          phoneNumber,
          "☀️ Morning digest enabled for 8:00 AM local time.",
        );

        break;
      }

      case INTENTS.DISABLE_DIGEST: {
        await setDigestEnabled(user._id, false);

        await sendFn(phoneNumber, "☀️ Morning digest disabled.");

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
          const reminder = await handleAiCreate(action, phoneNumber, user._id, sendFn, timezone);

          if (reminder) {
            await markInboundMessageProcessed(record._id);
            return reminder;
          }

          break;
        }

        if (action.action === "edit_reminder") {
          const updated = await handleAiEdit(action, phoneNumber, user._id, sendFn, timezone);

          if (updated) {
            await markInboundMessageProcessed(record._id);
            return updated;
          }

          break;
        }

        if (action.action === "delete_reminder") {
          const cancelled = await handleAiDelete(action, phoneNumber, user._id, sendFn, timezone);

          if (cancelled) {
            await markInboundMessageProcessed(record._id);
            return cancelled;
          }

          break;
        }

        if (action.action === "list_reminders") {
          await handleAiList(action, phoneNumber, user._id, sendFn, timezone);
          await markInboundMessageProcessed(record._id);
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