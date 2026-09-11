import {
  zonedStartOfDay,
  zonedDayDiff,
  zonedDayParts,
  zonedFormatTime,
} from "./timezone.js";

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const dayDiff = (date, now) =>
  Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86400_000);

/**
 * Human-readable reminder time label.
 *
 * "Today at 8:00 PM" / "Tomorrow at 8:00 PM" / "Monday at 8:00 PM"
 * (within the next 6 days) / "Sep 15 at 8:00 PM" (otherwise).
 *
 * When `timezone` is provided, the time and the calendar-day relation are
 * resolved in that zone; otherwise server-local behavior is preserved.
 */
export const formatReminderTimeLabel = (date, timezone, now = new Date()) => {
  const time = timezone
    ? zonedFormatTime(date, timezone)
    : new Date(date).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

  const diff = timezone ? zonedDayDiff(date, now, timezone) : dayDiff(date, now);

  if (diff === 0) {
    return `Today at ${time}`;
  }

  if (diff === 1) {
    return `Tomorrow at ${time}`;
  }

  if (diff > 1 && diff <= 6) {
    const parts = timezone
      ? zonedDayParts(date, timezone)
      : (() => {
          const d = new Date(date);
          return {
            weekday: d.getDay(),
            month: d.getMonth() + 1,
            day: d.getDate(),
            year: d.getFullYear(),
          };
        })();

    const weekdayName = timezone
      ? new Intl.DateTimeFormat([], {
          timeZone: timezone,
          weekday: "long",
        }).format(new Date(date))
      : new Date(date).toLocaleDateString([], { weekday: "long" });

    return `${weekdayName} at ${time}`;
  }

  const short = timezone
    ? new Intl.DateTimeFormat([], {
        timeZone: timezone,
        month: "short",
        day: "numeric",
      }).format(new Date(date))
    : new Date(date).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });

  return `${short} at ${time}`;
};

/**
 * Concise recurrence note for a reminder pattern, or null when the reminder
 * is not recurring.
 */
export const formatRecurrenceNote = (pattern) => {
  if (!pattern) {
    return null;
  }

  const WEEKDAYS = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  if (WEEKDAYS.includes(pattern)) {
    return `Repeats every ${pattern[0].toUpperCase()}${pattern.slice(1)}`;
  }

  const labels = {
    daily: "Repeats daily",
    weekly: "Repeats weekly",
    monthly: "Repeats monthly",
  };

  return labels[pattern] ?? null;
};