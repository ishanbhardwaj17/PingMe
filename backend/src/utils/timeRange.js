import { parseReminderText } from "./parser.js";
import {
  zonedStartOfDay,
  zonedDateShift,
  zonedDayParts,
  zonedLocalTimeInstant,
} from "./timezone.js";

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

/**
 * Start of the current Monday (week starts Monday). Server-local when no
 * timezone is given.
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
 * When `timezone` is provided, all boundaries are the user's local calendar
 * days in that zone (DST-aware via Intl); otherwise server-local behavior
 * is preserved.
 *
 * Pure and deterministic: the clock comes from the injected `now`; no
 * MongoDB access, no global state.
 *
 * @param {string} range - one of today|tomorrow|this_week|next_week|
 *   monday..sunday|date
 * @param {string|undefined} datePhrase - chrono-parseable phrase, only for
 *   range "date"
 * @param {Date|number} now - injectable clock
 * @param {string} [timezone] - IANA timezone for local boundaries
 * @returns {{ start: Date, end: Date, label: string } | null} - null when
 *   the range is not a resolvable time range (next_reminder) or the date
 *   phrase cannot be parsed
 */
export const resolveRange = (range, datePhrase, now, timezone) => {
  const current = new Date(now);

  if (range === "today") {
    const start = timezone
      ? zonedStartOfDay(current, timezone)
      : startOfDay(current);

    return {
      start,
      end: timezone
        ? zonedDateShift(start, 1, timezone)
        : addDays(start, 1),
      label: "today",
    };
  }

  if (range === "tomorrow") {
    const base = timezone
      ? zonedStartOfDay(current, timezone)
      : startOfDay(current);
    const start = timezone ? zonedDateShift(base, 1, timezone) : addDays(base, 1);

    return {
      start,
      end: timezone ? zonedDateShift(start, 1, timezone) : addDays(start, 1),
      label: "tomorrow",
    };
  }

  if (range === "this_week") {
    const base = timezone
      ? zonedStartOfDay(current, timezone)
      : startOfDay(current);

    if (!timezone) {
      const weekStart = startOfWeek(current);

      return { start: weekStart, end: addDays(weekStart, 7), label: "this week" };
    }

    const weekday = zonedDayParts(current, timezone).weekday;
    const mondayStart = zonedDateShift(base, -((weekday + 6) % 7), timezone);

    return {
      start: mondayStart,
      end: zonedDateShift(mondayStart, 7, timezone),
      label: "this week",
    };
  }

  if (range === "next_week") {
    const base = timezone
      ? zonedStartOfDay(current, timezone)
      : startOfDay(current);

    if (!timezone) {
      const weekStart = addDays(startOfWeek(current), 7);

      return { start: weekStart, end: addDays(weekStart, 7), label: "next week" };
    }

    const weekday = zonedDayParts(current, timezone).weekday;
    const nextMonday = zonedDateShift(
      base,
      7 - ((weekday + 6) % 7),
      timezone,
    );

    return {
      start: nextMonday,
      end: zonedDateShift(nextMonday, 7, timezone),
      label: "next week",
    };
  }

  if (WEEKDAYS.includes(range)) {
    const target = WEEKDAYS.indexOf(range);

    if (!timezone) {
      const currentDay = current.getDay();
      let diff = target - currentDay;

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

    const base = zonedStartOfDay(current, timezone);
    const parts = zonedDayParts(current, timezone);
    let diff = target - parts.weekday;

    if (diff < 0) {
      diff += 7;
    }

    if (diff === 0) {
      const dayOver = base.getTime() + 24 * 3600_000;
      const stillToday = current.getTime() < dayOver - DAY_OVER_GRACE_MS;

      if (!stillToday) {
        diff = 7;
      }
    }

    const start = zonedDateShift(base, diff, timezone);

    return {
      start,
      end: zonedDateShift(start, 1, timezone),
      label: WEEKDAY_LABELS[range],
    };
  }

  if (range === "date") {
    let parsed;

    try {
      parsed = parseReminderText(`Remind me to x ${datePhrase}`, timezone);
    } catch {
      return null;
    }

    const start = timezone
      ? zonedStartOfDay(parsed.reminderTime, timezone)
      : startOfDay(parsed.reminderTime);

    const label = timezone
      ? new Intl.DateTimeFormat([], {
          timeZone: timezone,
          month: "long",
          day: "numeric",
        }).format(start)
      : start.toLocaleDateString([], {
          month: "long",
          day: "numeric",
        });

    return {
      start,
      end: timezone
        ? zonedDateShift(start, 1, timezone)
        : addDays(start, 1),
      label,
    };
  }

  return null;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};