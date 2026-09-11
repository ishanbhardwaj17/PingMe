import { parseReminderText } from "./parser.js";

// Indexed to match Date.prototype.getDay() (Sunday = 0).
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const WEEKDAY_LABELS = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/**
 * "The day is over" grace: a weekday query resolves to today only while the
 * day still has more than a minute left; from 23:59 the nearest occurrence
 * rolls to next week (e.g. "Monday" at Monday 11:59 PM -> next Monday).
 */
const DAY_OVER_GRACE_MS = 60_000;

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * Start of the current Monday (week starts Monday), in server local time.
 */
const startOfWeek = (date) => {
  const d = startOfDay(date);
  const day = d.getDay();

  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));

  return d;
};

/**
 * Resolve a validated temporal intent into concrete local-day boundaries.
 *
 * Pure and deterministic: the clock comes from the injected `now`; no
 * MongoDB access, no global state. All boundaries use server-local calendar
 * arithmetic (setHours), never UTC, so the Asia/Kolkata +5:30 drift is
 * avoided.
 *
 * @param {string} range - one of today|tomorrow|this_week|next_week|
 *   monday..sunday|date
 * @param {string|undefined} datePhrase - chrono-parseable phrase, only for
 *   range "date"
 * @param {Date|number} now - injectable clock
 * @returns {{ start: Date, end: Date, label: string } | null} - null when
 *   the range is not a resolvable time range (next_reminder) or the date
 *   phrase cannot be parsed
 */
export const resolveRange = (range, datePhrase, now) => {
  const current = new Date(now);

  if (range === "today") {
    const start = startOfDay(current);

    return { start, end: addDays(start, 1), label: "today" };
  }

  if (range === "tomorrow") {
    const start = addDays(startOfDay(current), 1);

    return { start, end: addDays(start, 1), label: "tomorrow" };
  }

  if (range === "this_week") {
    const start = startOfWeek(current);

    return { start, end: addDays(start, 7), label: "this week" };
  }

  if (range === "next_week") {
    const start = addDays(startOfWeek(current), 7);

    return { start, end: addDays(start, 7), label: "next week" };
  }

  if (WEEKDAYS.includes(range)) {
    const target = WEEKDAYS.indexOf(range);
    let diff = target - current.getDay();

    if (diff < 0) {
      diff += 7;
    }

    if (diff === 0) {
      const dayOver = startOfDay(current).getTime() + 24 * 3600_000;
      const stillToday = current.getTime() < dayOver - DAY_OVER_GRACE_MS;

      if (!stillToday) {
        diff = 7;
      }
    }

    const start = addDays(startOfDay(current), diff);

    return {
      start,
      end: addDays(start, 1),
      label: WEEKDAY_LABELS[range],
    };
  }

  if (range === "date") {
    let parsed;

    try {
      parsed = parseReminderText(`Remind me to x ${datePhrase}`);
    } catch {
      return null;
    }

    const start = startOfDay(parsed.reminderTime);

    return {
      start,
      end: addDays(start, 1),
      label: start.toLocaleDateString([], {
        month: "long",
        day: "numeric",
      }),
    };
  }

  return null;
};