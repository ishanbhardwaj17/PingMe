import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneNumber } from "../src/utils/phone.js";

describe("normalizePhoneNumber", () => {
  it('normalizes "+918824895152"', () => {
    assert.equal(normalizePhoneNumber("+918824895152"), "918824895152");
  });

  it('normalizes "918824895152"', () => {
    assert.equal(normalizePhoneNumber("918824895152"), "918824895152");
  });

  it('normalizes "+91 8824 895152"', () => {
    assert.equal(normalizePhoneNumber("+91 8824 895152"), "918824895152");
  });

  it('normalizes "91-8824-895152"', () => {
    assert.equal(normalizePhoneNumber("91-8824-895152"), "918824895152");
  });

  it('normalizes "(91) 8824895152"', () => {
    assert.equal(normalizePhoneNumber("(91) 8824895152"), "918824895152");
  });

  it('keeps "16315551181" unchanged', () => {
    assert.equal(normalizePhoneNumber("16315551181"), "16315551181");
  });

  it("keeps already-normalized digits unchanged", () => {
    assert.equal(normalizePhoneNumber("918824895152"), "918824895152");
  });

  it("does not invent a country code for a bare local number", () => {
    assert.equal(normalizePhoneNumber("8824895152"), "8824895152");
  });

  it("throws for undefined, null, empty, whitespace-only, and non-string input", () => {
    for (const input of [undefined, null, "", "   ", 12345]) {
      assert.throws(() => normalizePhoneNumber(input), /Phone number is required/);
    }
  });

  it("rejects alphabetic and gibberish input instead of stripping it", () => {
    for (const input of ["abc", "abc123", "/12345/", "91-8824-x895152", "call me at 8"]) {
      assert.throws(() => normalizePhoneNumber(input), /Invalid phone number/);
    }
  });

  it("rejects strings that contain only formatting characters", () => {
    for (const input of ["()+- ", "+-()", "(  )  +-"]) {
      assert.throws(() => normalizePhoneNumber(input), /Phone number is required/);
    }
  });
});