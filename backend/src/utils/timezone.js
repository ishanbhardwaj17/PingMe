/**
 * IANA-timezone helpers built on Intl. No external dependency; the runtime's
 * Intl implementation is the single authority for zone offsets and DST.
 */

/**
 * Whether a string is a valid IANA timezone identifier accepted by the
 * runtime (e.g. "Asia/Kolkata", "America/New_York"). Case-insensitive per
 * the Intl spec.
 */
export const isValidTimezone = (timezone) => {
  if (typeof timezone !== "string" || timezone.trim() === "") {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The offset (in milliseconds) of `timezone` at the given absolute instant.
 * DST-aware: evaluated at the instant, so it reflects the current zone rule.
 */
const offsetMsAt = (instant, timezone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));

  const name = parts.find((part) => part.type === "timeZoneName")?.value;

  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? "");

  if (!match) {
    return 0;
  }

  const sign = match[1] === "+" ? 1 : -1;

  return sign * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60) * 1000;
};

const FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * The wall-clock calendar components of `instant` in `timezone` (all local
 * fields; weekday is the 0-6 JS convention of the zone's calendar date).
 */
export const zonedDayParts = (instant, timezone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));

  const get = (type) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const year = get("year");
  const month = get("month");
  const day = get("day");

  const utcSerial = Date.UTC(year, month - 1, day);
  const weekday = new Date(utcSerial).getUTCDay();

  return {
    year,
    month,
    day,
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
    weekday,
  };
};

/**
 * The absolute instant of local midnight (00:00) for the calendar date of
 * `instant` in `timezone`.
 */
export const zonedStartOfDay = (instant, timezone) => {
  const parts = zonedDayParts(instant, timezone);

  return zonedLocalTimeInstant(
    parts.year,
    parts.month,
    parts.day,
    0,
    0,
    timezone,
  );
};

/**
 * Shift a local-midnight instant by whole local calendar days.
 */
export const zonedDateShift = (start, days, timezone) => {
  const parts = zonedDayParts(start, timezone);

  return zonedLocalTimeInstant(
    parts.year,
    parts.month,
    parts.day + days,
    0,
    0,
    timezone,
  );
};

/**
 * The absolute instant at which the wall clock in `timezone` reads the given
 * local calendar date and time. DST-correct: the zone offset is evaluated at
 * the resulting instant (single refinement pass).
 */
export const zonedLocalTimeInstant = (year, month, day, hour, minute, timezone) => {
  const candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = offsetMsAt(candidate, timezone);
  const resolved = candidate - offset;
  const refinedOffset = offsetMsAt(resolved, timezone);

  return new Date(resolved - (refinedOffset - offset));
};

/**
 * The zone's local clock time as "8:00 PM".
 */
export const zonedFormatTime = (date, timezone) => {
  const formatter = new Intl.DateTimeFormat([], {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });

  return formatter.format(new Date(date));
};

/**
 * Difference in whole local calendar days between two instants in a zone
 * (0 = same local date, 1 = the next local date).
 */
export const zonedDayDiff = (dateA, dateB, timezone) => {
  const a = zonedDayParts(dateA, timezone);
  const b = zonedDayParts(dateB, timezone);

  const serialA = Date.UTC(a.year, a.month - 1, a.day);
  const serialB = Date.UTC(b.year, b.month - 1, b.day);

  return Math.round((serialA - serialB) / 86400_000);
};