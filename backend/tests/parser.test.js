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

  it('A: parses "Remind me tomorrow at 8 PM to call Mom"', () => {
    const parsed = parseReminderText("Remind me tomorrow at 8 PM to call Mom");

    assert.equal(parsed.task, "call Mom");

    const date = new Date(parsed.reminderTime);

    assert.equal(date.getHours(), 20);
  });

  it('B: parses "Remind me to call Mom tomorrow at 8 PM" to the same result', () => {
    const first = parseReminderText("Remind me tomorrow at 8 PM to call Mom");
    const second = parseReminderText("Remind me to call Mom tomorrow at 8 PM");

    assert.equal(second.task, "call Mom");
    assert.equal(
      new Date(second.reminderTime).getTime(),
      new Date(first.reminderTime).getTime(),
    );
  });

  it("D: preserves recurrence phrasing in the task (existing semantics)", () => {
    const parsed = parseReminderText(
      "Remind me to take medicine every day at 8 PM",
    );

    assert.equal(parsed.task, "take medicine every day");

    const date = new Date(parsed.reminderTime);

    assert.equal(date.getHours(), 20);
  });
});