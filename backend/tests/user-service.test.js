import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../src/models/user.model.js";
import { findOrCreateUser } from "../src/services/user.service.js";

const FIXTURE_PREFIX = "9199998800";

const cleanupFixture = async () => {
  await User.deleteMany({ phoneNumber: { $regex: `^${FIXTURE_PREFIX}` } });
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(cleanupFixture);

after(async () => {
  await cleanupFixture();
  await mongoose.disconnect();
});

describe("findOrCreateUser", () => {
  it("returns the same user for different representations of one number", async () => {
    const first = await findOrCreateUser("+91 9999 88001");
    const second = await findOrCreateUser("91999988001");
    const third = await findOrCreateUser("+91999988001");

    assert.equal(first._id.toString(), second._id.toString());
    assert.equal(first._id.toString(), third._id.toString());

    assert.equal(first.phoneNumber, "91999988001");

    const stored = await User.countDocuments({ phoneNumber: "91999988001" });

    assert.equal(stored, 1);
  });

  it("stores only the canonical digits-only form", async () => {
    await findOrCreateUser("(91) 9999 88001");

    const user = await User.findOne({ phoneNumber: "91999988001" });

    assert.ok(user);
    assert.equal(user.phoneNumber, "91999988001");
    assert.equal(await User.countDocuments({ phoneNumber: "+91999988001" }), 0);
  });

  it("creates exactly one user under concurrent creation of the same number", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => findOrCreateUser("+91999988002")),
    );

    const ids = new Set(results.map((user) => user._id.toString()));

    assert.equal(ids.size, 1);
    assert.equal(await User.countDocuments({ phoneNumber: "91999988002" }), 1);
  });

  it("throws for missing phone numbers", async () => {
    await assert.rejects(() => findOrCreateUser(undefined), /Phone number is required/);
  });
});