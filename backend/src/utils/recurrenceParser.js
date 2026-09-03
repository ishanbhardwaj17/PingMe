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

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

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
 */
export const advanceOccurrence = (reminderTime, pattern, anchorDay = null) => {
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

  return next;
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
) => {
  if (!pattern) {
    return new Date(reminderTime.getTime());
  }

  let next = new Date(reminderTime.getTime());

  while (next.getTime() <= now.getTime()) {
    next = advanceOccurrence(next, pattern, anchorDay);
  }

  return next;
};

/**
 * Calculate the next occurrence after the given reminder time.
 * Used by the worker to schedule the following occurrence after delivery.
 */
export const nextOccurrence = (reminderTime, pattern, anchorDay = null) =>
  advanceOccurrence(reminderTime, pattern, anchorDay);