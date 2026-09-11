import Reminder from "../models/reminder.model.js";
import User from "../models/user.model.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";
import { zonedStartOfDay, zonedDateShift, zonedFormatTime, zonedDayParts } from "../utils/timezone.js";

/**
 * The user's selectable reminders for their local calendar day: pending,
 * undelivered, future, and inside [localStartOfDay, localStartOfNextDay).
 */
export const getLocalDayReminders = async (userId, timezone, now = new Date()) => {
  const start = zonedStartOfDay(now, timezone);
  const end = zonedDateShift(start, 1, timezone);

  return Reminder.find({
    userId,
    status: "pending",
    deliveredAt: null,
    reminderTime: {
      $gte: start,
      $lt: end,
      $gt: now,
    },
  })
    .sort({ reminderTime: 1, _id: 1 })
    .lean();
};

/**
 * The morning digest message for a user's local day, formatted in the
 * user's timezone. Selectable/upcoming reminders only.
 */
export const generateDigest = async (userId, timezone, now = new Date()) => {
  const reminders = await getLocalDayReminders(userId, timezone, now);

  if (reminders.length === 0) {
    return "No reminders for today 🎉";
  }

  const lines = ["☀️ Good morning!", "", `You have ${reminders.length} reminder${reminders.length === 1 ? "" : "s"} today:`, ""];

  for (const [index, reminder] of reminders.entries()) {
    lines.push(
      `${index + 1}. ${reminder.task}`,
      `   🕐 ${zonedFormatTime(reminder.reminderTime, timezone)}`,
    );
  }

  return lines.join("\n");
};

/**
 * One scheduler pass: for every user with the digest enabled, if their
 * local clock is inside the 8:00 AM window, atomically claim the local date
 * and send the digest. The Mongo claim (digestEnabled + lastDigestSentDate
 * mismatch) guarantees at most one digest per user per local calendar day,
 * across restarts, retries, and duplicate scheduler instances.
 *
 * @param {object} [options] - { now, sendFn } injectable for tests
 */
export const runDigestSchedulerPass = async ({
  now = new Date(),
  sendFn = sendWhatsAppMessage,
} = {}) => {
  const users = await User.find({ digestEnabled: true })
    .select("_id phoneNumber timezone")
    .lean();

  let sent = 0;

  for (const user of users) {
    try {
      let timezone = user.timezone;

      if (!timezone) {
        continue;
      }

      let parts;

      try {
        parts = zonedDayParts(now, timezone);
      } catch {
        continue;
      }

      if (parts.hour !== 8) {
        continue;
      }

      const localDate = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

      const claimed = await User.updateOne(
        {
          _id: user._id,
          digestEnabled: true,
          $or: [{ lastDigestSentDate: null }, { lastDigestSentDate: { $ne: localDate } }],
        },
        { $set: { lastDigestSentDate: localDate } },
      );

      if (claimed.modifiedCount !== 1) {
        continue;
      }

      const message = await generateDigest(user._id, timezone, now);

      await sendFn(user.phoneNumber, message);

      sent++;
    } catch (error) {
      console.error(`Digest scheduler failed for ${user._id}:`, error.message);
    }
  }

  return sent;
};