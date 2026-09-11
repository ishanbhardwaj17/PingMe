import * as chrono from "chrono-node";
import { zonedLocalTimeInstant, zonedDayParts } from "./timezone.js";

/**
 * Parse a reminder message into a task and an absolute reminder time.
 *
 * When `timezone` is provided, wall-clock phrases ("tomorrow at 8 PM",
 * "at 8 PM", "Monday 9 AM", "September 15") are resolved as that
 * timezone's local wall time and converted to the absolute instant.
 * Relative/duration phrases ("in 30 minutes", "for 30 minutes") stay
 * absolute (now + duration), as detected by chrono's timezoneOffset marker.
 *
 * @param {string} message
 * @param {string} [timezone] - IANA timezone for wall-clock resolution
 * @returns {{ task: string, reminderTime: Date, hourSpecified: boolean }}
 */
export const parseReminderText = (message, timezone) => {
  const results = chrono.parse(message);

  if (!results.length) {
    throw new Error("Could not understand date/time");
  }

  const result = results[0];
  const reminderTime = applyTimezone(result, timezone);

  // Remove the leading command prefix ("Remind me ..." or "Remind me to ...").
  // The word boundary after "to" prevents eating the "to" of words like
  // "tomorrow".
  const prefixStripped = message.replace(/^remind me(?:\s+to\b)?\s*/i, "");
  const prefixLength = message.length - prefixStripped.length;

  // Remove every chrono-matched date/time span by index, so task words that
  // merely resemble time text elsewhere in the message are untouched.
  const spans = results
    .map((res) => ({
      start: Math.max(0, res.index - prefixLength),
      end: Math.max(
        0,
        Math.min(
          prefixStripped.length,
          res.index + res.text.length - prefixLength,
        ),
      ),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  let task = "";
  let cursor = 0;

  for (const span of spans) {
    if (span.start > cursor) {
      task += prefixStripped.slice(cursor, span.start);
    }

    cursor = Math.max(cursor, span.end);
  }

  task += prefixStripped.slice(cursor);

  // "Remind me <time> to <task>" word order leaves a leading "to" before
  // the task once the time span is removed.
  return {
    task: task.replace(/^\s*to\b\s*/i, "").trim(),
    reminderTime,
    // Whether the parsed phrase explicitly specifies an hour (e.g.
    // "tomorrow at 9 PM" -> true, "tomorrow" -> false). Used by
    // post-delivery "remind me again" to preserve the original
    // time-of-day for date-only phrases.
    hourSpecified: result.start.isCertain("hour"),
  };
};

/**
 * Resolve the absolute instant of a chrono result.
 *
 * chrono computes wall-clock values (year/month/day/hour/minute) that are
 * timezone-independent, but resolves the final instant in the server's
 * local timezone. Relative phrases ("in 30 minutes") carry an explicit
 * timezoneOffset and are kept as-is (absolute durations). Everything else
 * is rebuilt in the user's timezone from the wall-clock components.
 */
const applyTimezone = (result, timezone) => {
  const resolved = result.start.date();

  if (!timezone || result.start.knownValues.timezoneOffset !== undefined) {
    return resolved;
  }

  const values = { ...result.start.impliedValues, ...result.start.knownValues };

  if (
    typeof values.year !== "number" ||
    typeof values.month !== "number" ||
    typeof values.day !== "number"
  ) {
    return resolved;
  }

  let hour = typeof values.hour === "number" ? values.hour : 12;
  let minute = typeof values.minute === "number" ? values.minute : 0;

  // Date-only phrases ("tomorrow", "September 15") carry the current
  // time-of-day: use the user's current local wall time, not the server's.
  if (!result.start.isCertain("hour")) {
    const nowParts = zonedDayParts(Date.now(), timezone);

    hour = nowParts.hour;
    minute = nowParts.minute;
  }

  return zonedLocalTimeInstant(
    values.year,
    values.month,
    values.day,
    hour,
    minute,
    timezone,
  );
};