import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectRecurrence,
  advanceOccurrence,
  resolveFutureOccurrence,
  nextOccurrence,
  isValidRecurrencePattern,
} from "../src/utils/recurrenceParser.js";

const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min);

describe("detectRecurrence", () => {
  it("detects daily recurrence", () => {
    assert.equal(
      detectRecurrence("Remind me to study every day at 9pm"),
      "daily",
    );
  });

  it("detects weekly recurrence", () => {
    assert.equal(
      detectRecurrence("Remind me to review every week at 8am"),
      "weekly",
    );
  });

  it("detects monthly recurrence", () => {
    assert.equal(
      detectRecurrence("Remind me to pay rent every month"),
      "monthly",
    );
  });

  it("detects weekday recurrence for every day of the week", () => {
    const days = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];

    for (const day of days) {
      assert.equal(
        detectRecurrence(`Remind me to exercise every ${day} at 7am`),
        day,
        `should detect every ${day}`,
      );
    }
  });

  it("returns null for non-recurring messages", () => {
    assert.equal(detectRecurrence("Remind me to call mom tomorrow at 8pm"), null);
  });
});

describe("advanceOccurrence", () => {
  it("advances daily by one day", () => {
    const next = advanceOccurrence(at(2026, 8, 3, 21, 0), "daily");

    assert.equal(next.getTime(), at(2026, 8, 4, 21, 0).getTime());
  });

  it("advances weekly by seven days", () => {
    const next = advanceOccurrence(at(2026, 8, 3, 9, 0), "weekly");

    assert.equal(next.getTime(), at(2026, 8, 10, 9, 0).getTime());
  });

  it("advances weekday patterns by seven days, preserving the anchor weekday", () => {
    const next = advanceOccurrence(at(2026, 8, 7, 19, 0), "monday");

    assert.equal(next.getTime(), at(2026, 8, 14, 19, 0).getTime());
  });

  it("clamps January 31 to the last valid day of February", () => {
    const next = advanceOccurrence(at(2027, 0, 31, 9, 30), "monthly");

    assert.equal(next.getTime(), at(2027, 1, 28, 9, 30).getTime());
  });

  it("clamps January 31 to February 29 in a leap year", () => {
    const next = advanceOccurrence(at(2028, 0, 31, 9, 30), "monthly");

    assert.equal(next.getTime(), at(2028, 1, 29, 9, 30).getTime());
  });

  it("clamps March 31 to April 30", () => {
    const next = advanceOccurrence(at(2027, 2, 31, 9, 30), "monthly");

    assert.equal(next.getTime(), at(2027, 3, 30, 9, 30).getTime());
  });

  it("clamps May 31 to June 30", () => {
    const next = advanceOccurrence(at(2027, 4, 31, 9, 30), "monthly");

    assert.equal(next.getTime(), at(2027, 5, 30, 9, 30).getTime());
  });

  it("preserves a 31st anchor across February into March", () => {
    const feb = advanceOccurrence(at(2027, 0, 31, 9, 30), "monthly", 31);
    const mar = advanceOccurrence(feb, "monthly", 31);
    const apr = advanceOccurrence(mar, "monthly", 31);
    const may = advanceOccurrence(apr, "monthly", 31);

    assert.equal(feb.getTime(), at(2027, 1, 28, 9, 30).getTime());
    assert.equal(mar.getTime(), at(2027, 2, 31, 9, 30).getTime());
    assert.equal(apr.getTime(), at(2027, 3, 30, 9, 30).getTime());
    assert.equal(may.getTime(), at(2027, 4, 31, 9, 30).getTime());
  });

  it("preserves a 31st anchor in a leap year", () => {
    const feb = advanceOccurrence(at(2028, 0, 31, 9, 0), "monthly", 31);
    const mar = advanceOccurrence(feb, "monthly", 31);

    assert.equal(feb.getTime(), at(2028, 1, 29, 9, 0).getTime());
    assert.equal(mar.getTime(), at(2028, 2, 31, 9, 0).getTime());
  });

  it("preserves a 30th anchor across February into March", () => {
    const feb = advanceOccurrence(at(2027, 0, 30, 9, 0), "monthly", 30);
    const mar = advanceOccurrence(feb, "monthly", 30);

    assert.equal(feb.getTime(), at(2027, 1, 28, 9, 0).getTime());
    assert.equal(mar.getTime(), at(2027, 2, 30, 9, 0).getTime());
  });

  it("does not change daily, weekly, or weekday behavior when an anchor is supplied", () => {
    const daily = advanceOccurrence(at(2026, 8, 3, 21, 0), "daily", 31);
    const weekly = advanceOccurrence(at(2026, 8, 3, 9, 0), "weekly", 31);
    const monday = advanceOccurrence(at(2026, 8, 7, 19, 0), "monday", 31);

    assert.equal(daily.getTime(), at(2026, 8, 4, 21, 0).getTime());
    assert.equal(weekly.getTime(), at(2026, 8, 10, 9, 0).getTime());
    assert.equal(monday.getTime(), at(2026, 8, 14, 19, 0).getTime());
  });
});

describe("resolveFutureOccurrence", () => {
  it("keeps a recurring time unchanged when it is still later today", () => {
    const now = at(2026, 8, 3, 8, 0);
    const target = at(2026, 8, 3, 21, 0);

    const resolved = resolveFutureOccurrence(target, "daily", now);

    assert.equal(resolved.getTime(), target.getTime());
  });

  it("moves a daily reminder to tomorrow when today's time already passed", () => {
    const now = at(2026, 8, 3, 22, 0);
    const target = at(2026, 8, 3, 21, 0);

    const resolved = resolveFutureOccurrence(target, "daily", now);

    assert.equal(resolved.getTime(), at(2026, 8, 4, 21, 0).getTime());
  });

  it("resolves a weekly pattern whose anchor already passed", () => {
    const now = at(2026, 8, 2, 12, 0);
    const target = at(2026, 7, 31, 19, 0);

    const resolved = resolveFutureOccurrence(target, "weekly", now);

    assert.equal(resolved.getTime(), at(2026, 8, 7, 19, 0).getTime());
  });

  it("resolves a weekday pattern when the target day is later in the week", () => {
    const now = at(2026, 8, 7, 8, 0);
    const target = at(2026, 8, 2, 19, 0);

    const resolved = resolveFutureOccurrence(target, "wednesday", now);

    assert.equal(resolved.getTime(), at(2026, 8, 9, 19, 0).getTime());
  });

  it("resolves a weekday pattern to the following week after day+time passed", () => {
    const now = at(2026, 8, 7, 19, 30);
    const target = at(2026, 8, 7, 19, 0);

    const resolved = resolveFutureOccurrence(target, "monday", now);

    assert.equal(resolved.getTime(), at(2026, 8, 14, 19, 0).getTime());
  });

  it("resolves a monthly occurrence to the next month with clamping", () => {
    const now = at(2027, 1, 15, 10, 0);
    const target = at(2027, 0, 31, 9, 0);

    const resolved = resolveFutureOccurrence(target, "monthly", now);

    assert.equal(resolved.getTime(), at(2027, 1, 28, 9, 0).getTime());
  });

  it("preserves the anchor while resolving a past monthly occurrence", () => {
    const now = at(2027, 2, 5, 10, 0);
    const target = at(2027, 0, 31, 9, 0);

    const resolved = resolveFutureOccurrence(target, "monthly", now, 31);

    assert.equal(resolved.getTime(), at(2027, 2, 31, 9, 0).getTime());
  });

  it("returns non-recurring times unchanged even when in the past", () => {
    const target = at(2026, 8, 2, 19, 0);

    const resolved = resolveFutureOccurrence(target, null, at(2026, 8, 3, 8, 0));

    assert.equal(resolved.getTime(), target.getTime());
  });
});

describe("nextOccurrence", () => {
  it("produces a future occurrence after a delivered reminder", () => {
    const next = nextOccurrence(at(2026, 8, 3, 21, 0), "daily");

    assert.equal(next.getTime(), at(2026, 8, 4, 21, 0).getTime());
  });

  it("generates multiple monthly occurrences with a stable anchor", () => {
    const expected = [
      at(2027, 1, 28, 9, 0),
      at(2027, 2, 31, 9, 0),
      at(2027, 3, 30, 9, 0),
      at(2027, 4, 31, 9, 0),
    ];

    let current = at(2027, 0, 31, 9, 0);

    for (const expectedOccurrence of expected) {
      current = nextOccurrence(current, "monthly", 31);

      assert.equal(current.getTime(), expectedOccurrence.getTime());
    }
  });

  it("does not store or use an anchor for non-monthly patterns", () => {
    const next = nextOccurrence(at(2026, 8, 3, 21, 0), "daily", null);

    assert.equal(next.getTime(), at(2026, 8, 4, 21, 0).getTime());
  });
});

describe("isValidRecurrencePattern", () => {
  it("accepts all supported patterns and null", () => {
    const patterns = [
      "daily",
      "weekly",
      "monthly",
      "monday",
      "sunday",
      null,
    ];

    for (const pattern of patterns) {
      assert.equal(isValidRecurrencePattern(pattern), true);
    }
  });

  it("rejects unknown patterns", () => {
    assert.equal(isValidRecurrencePattern("yearly"), false);
  });
});