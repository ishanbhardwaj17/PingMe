import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReminderText } from "../src/utils/parser.js";

describe("parseReminderText", () => {
  it("parses a relative reminder", () => {
    const parsed = parseReminderText("Remind me to drink water in 2 minutes");

    assert.equal(parsed.task, "drink water");

    const deltaMs = new Date(parsed.reminderTime).getTime() - Date.now();

    assert.ok(deltaMs > 60_000, "should be at least 1 minute in the future");
    assert.ok(deltaMs < 3 * 60_000, "should be at most 3 minutes in the future");
  });

  it("parses an absolute date/time reminder", () => {
    const parsed = parseReminderText("Remind me to call mom tomorrow at 8pm");

    assert.equal(parsed.task, "call mom");

    const date = new Date(parsed.reminderTime);

    assert.equal(date.getHours(), 20);
  });

  it("throws a useful error when no date/time can be parsed", () => {
    assert.throws(
      () => parseReminderText("this is a text message"),
      /Could not understand date\/time/,
    );
  });

  it("extracts the task text and strips the time expression", () => {
    const parsed = parseReminderText(
      "Remind me to water the plants tomorrow at 9am",
    );

    assert.equal(parsed.task, "water the plants");
  });
});