import * as chrono from "chrono-node";

export const parseReminderText = (message) => {
  const results = chrono.parse(message);

  if (!results.length) {
    throw new Error("Could not understand date/time");
  }

  const reminderTime = results[0].start.date();

  // Remove the leading command prefix ("Remind me ..." or "Remind me to ...").
  // The word boundary after "to" prevents eating the "to" of words like
  // "tomorrow".
  const prefixStripped = message.replace(/^remind me(?:\s+to\b)?\s*/i, "");
  const prefixLength = message.length - prefixStripped.length;

  // Remove every chrono-matched date/time span by index, so task words that
  // merely resemble time text elsewhere in the message are untouched.
  const spans = results
    .map((result) => ({
      start: Math.max(0, result.index - prefixLength),
      end: Math.max(
        0,
        Math.min(
          prefixStripped.length,
          result.index + result.text.length - prefixLength,
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
    hourSpecified: results[0].start.isCertain("hour"),
  };
};