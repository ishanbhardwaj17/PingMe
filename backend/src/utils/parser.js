import * as chrono from "chrono-node";

export const parseReminderText = (message) => {
  const results = chrono.parse(message);

  if (!results.length) {
    throw new Error("Could not understand date/time");
  }

  const parsedDate = results[0].start.date();

  const dateText = results[0].text;

  let task = message
    .replace(/remind me to/i, "")
    .replace(dateText, "")
    .trim();

  return {
    task,
    reminderTime: parsedDate,
  };
};