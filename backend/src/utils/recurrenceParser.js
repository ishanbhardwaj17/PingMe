export const RECURRENCE_PATTERNS = [
  "daily",
  "weekly",
  "monthly",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

import { zonedDayParts, zonedLocalTimeInstant } from "./timezone.js";

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const RECURRENCE_PATTERN_WORDS = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  monday: "monday",
  tuesday: "tuesday",
  wednesday: "wednesday",
  thursday: "thursday",
  friday: "friday",
  saturday: "saturday",
  sunday: "sunday",
};

/**
 * Remove parser-recognized recurrence residue from the START of a parsed
 * task ("every day  to drink water" -> "drink water"). Narrow by design:
 * it only strips a leading "every <pattern-word>" plus an optional
 * creation connector (to/about) at the task boundary. Task text that merely
 * contains recurrence-like words later in the sentence ("... review the
 * every day report") is never touched, and a "to"-initial task ("toast") is
 * protected by a word boundary.
 */
export const cleanRecurringTask = (task, recurrencePattern) => {
  if (!recurrencePattern || typeof task !== "string") {
    return task;
  }

  const word = RECURRENCE_PATTERN_WORDS[recurrencePattern];

  if (!word) {
    return task;
  }

  const regex = new RegExp(
    `^every(?:\\s+${word})?(?:\\s+(?:to|about)\\b)?\\s*`,
    "i",
  );

  const cleaned = task.replace(regex, "").trim();

  return cleaned || task.trim();
};

export const isValidRecurrencePattern = (pattern) =>
  pattern === null || RECURRENCE_PATTERNS.includes(pattern);

export const detectRecurrence = (text) => {
  const lower = text.toLowerCase();

  if (lower.includes("every day")) {
    return "daily";
  }

  if (lower.includes("every week")) {
    return "weekly";
  }

  if (lower.includes("every month")) {
    return "monthly";
  }

  for (const day of WEEKDAYS) {
    if (lower.includes(`every ${day}`)) {
      return day;
    }
  }

  return null;
};

/**
 * Advance a reminder time by exactly one occurrence step for the given pattern.
 *
 * Weekly and weekday patterns advance by 7 days, preserving the anchor
 * weekday and time of day.
 *
 * Monthly occurrences are clamped to the last valid day of the target month
 * (e.g. Jan 31 -> Feb 28/29, Mar 31 -> Apr 30). When an anchor day is
 * provided it is preserved across months: Jan 31 -> Feb 28 -> Mar 31 ->
 * Apr 30 -> May 31. Without an anchor (legacy reminders), the day of the
 * current occurrence is used and may drift after a short month.
 *
 * When `timezone` is provided, the occurrence's local wall time and the
 * pattern arithmetic are evaluated in that zone (DST-aware); the result is
 * the absolute instant of the next local occurrence. Without a timezone,
 * server-local behavior is preserved.
 */
export const advanceOccurrence = (
  reminderTime,
  pattern,
  anchorDay = null,
  timezone = null,
) => {
  const next = new Date(reminderTime.getTime());

  if (pattern === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (pattern === "weekly" || WEEKDAYS.includes(pattern)) {
    next.setDate(next.getDate() + 7);
  } else if (pattern === "monthly") {
    const fallbackDay = next.getDate();
    const targetMonth = next.getMonth() + 1;

    next.setMonth(targetMonth, 1);

    const lastValidDay = new Date(
      next.getFullYear(),
      targetMonth + 1,
      0,
    ).getDate();

    next.setDate(Math.min(anchorDay ?? fallbackDay, lastValidDay));
  }

  if (!timezone) {
    return next;
  }

  return advanceOccurrenceZoned(reminderTime, next, pattern, anchorDay, timezone);
};

/**
 * Rebuild the advanced occurrence's absolute instant from its local wall
 * time in the user's timezone (DST-aware), so a daily 8:00 AM reminder
 * stays 8:00 AM local across DST transitions.
 */
const advanceOccurrenceZoned = (reminderTime, serverNext, pattern, anchorDay, timezone) => {
  const parts = zonedDayParts(reminderTime, timezone);

  let year = parts.year;
  let month = parts.month;
  let day = parts.day;
  const hour = parts.hour;
  const minute = parts.minute;

  if (pattern === "daily") {
    day += 1;
  } else if (pattern === "weekly" || WEEKDAYS.includes(pattern)) {
    day += 7;
  } else if (pattern === "monthly") {
    month += 1;

    const lastValidDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

    day = Math.min(anchorDay ?? day, lastValidDay);
  }

  return zonedLocalTimeInstant(year, month, day, hour, minute, timezone);
};

/**
 * Return the first occurrence of a recurring reminder that is strictly in
 * the future relative to `now`. Non-recurring (null) patterns are returned
 * unchanged.
 */
export const resolveFutureOccurrence = (
  reminderTime,
  pattern,
  now = new Date(),
  anchorDay = null,
  timezone = null,
) => {
  if (!pattern) {
    return new Date(reminderTime.getTime());
  }

  let next = new Date(reminderTime.getTime());

  while (next.getTime() <= now.getTime()) {
    next = advanceOccurrence(next, pattern, anchorDay, timezone);
  }

  return next;
};

/**
 * Calculate the next occurrence after the given reminder time.
 * Used by the worker to schedule the following occurrence after delivery.
 */
export const nextOccurrence = (
  reminderTime,
  pattern,
  anchorDay = null,
  timezone = null,
) => advanceOccurrence(reminderTime, pattern, anchorDay, timezone);