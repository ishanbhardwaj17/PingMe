const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const dayDiff = (date, now) =>
  Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86400_000);

/**
 * Human-readable reminder time label in server local time.
 *
 * "Today at 8:00 PM" / "Tomorrow at 8:00 PM" / "Monday at 8:00 PM"
 * (within the next 6 days) / "Sep 15 at 8:00 PM" (otherwise).
 */
export const formatReminderTimeLabel = (date, now = new Date()) => {
  const time = new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const diff = dayDiff(date, now);

  if (diff === 0) {
    return `Today at ${time}`;
  }

  if (diff === 1) {
    return `Tomorrow at ${time}`;
  }

  if (diff > 1 && diff <= 6) {
    const weekday = new Date(date).toLocaleDateString([], {
      weekday: "long",
    });

    return `${weekday} at ${time}`;
  }

  const short = new Date(date).toLocaleDateString([], {
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