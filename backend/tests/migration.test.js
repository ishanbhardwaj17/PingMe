import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../src/models/user.model.js";
import Reminder from "../src/models/reminder.model.js";
import {
  migratePhones,
  selectSurvivor,
} from "../scripts/migrate-phones.js";

const FIXTURE_PREFIX = "9199999900";
const SCOPE = ["91999999001", "91999999002", "91999999003", "91999999004"];

const userById = (id) => String(id);

const fixtureUserCount = async () =>
  User.countDocuments({
    $or: [{ whatsappName: { $in: FIXTURE_NAMES } }, { phoneNumber: { $regex: FIXTURE_PREFIX } }],
  });

const fixtureReminderCount = async () =>
  Reminder.countDocuments({ task: { $regex: /^mig-fixture/ } });

const FIXTURE_NAMES = ["A1", "A2", "B1", "B2", "C1", "C2", "D1", "D2", "D3"];

const cleanup = async () => {
  await Reminder.deleteMany({ task: { $regex: /^mig-fixture/ } });
  await User.deleteMany({ whatsappName: { $in: FIXTURE_NAMES } });
  await User.deleteMany({ phoneNumber: { $regex: `^${FIXTURE_PREFIX}` } });
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await cleanup();

  // Pair A: both users own reminders
  const a1 = await User.create({
    phoneNumber: "+91999999001",
    whatsappName: "A1",
  });
  const a2 = await User.create({
    phoneNumber: "91999999001",
    whatsappName: "A2",
  });

  await Reminder.create([
    { phoneNumber: "9999999999", task: "mig-fixture a1-1", reminderTime: new Date(), userId: a1._id },
    { phoneNumber: "9999999999", task: "mig-fixture a1-2", reminderTime: new Date(), userId: a1._id },
    { phoneNumber: "9999999999", task: "mig-fixture a2-1", reminderTime: new Date(), userId: a2._id },
  ]);

  // Pair B: only one user owns reminders
  await User.create({ phoneNumber: "+91999999002", whatsappName: "B1" });

  const b2 = await User.create({
    phoneNumber: "91999999002",
    whatsappName: "B2",
  });

  await Reminder.create([
    { phoneNumber: "9999999999", task: "mig-fixture b2-1", reminderTime: new Date(), userId: b2._id },
    { phoneNumber: "9999999999", task: "mig-fixture b2-2", reminderTime: new Date(), userId: b2._id },
  ]);

  // Pair C: neither user owns reminders
  await User.create({ phoneNumber: "+91999999003", whatsappName: "C1" });
  await User.create({ phoneNumber: "91999999003", whatsappName: "C2" });

  // Trio D: three duplicates, one owns a reminder
  const d1 = await User.create({
    phoneNumber: "+91999999004",
    whatsappName: "D1",
  });

  await User.create({ phoneNumber: "91999999004", whatsappName: "D2" });
  await User.create({ phoneNumber: "+91 9999 99004", whatsappName: "D3" });

  await Reminder.create({
    phoneNumber: "9999999999",
    task: "mig-fixture d1-1",
    reminderTime: new Date(),
    userId: d1._id,
  });
});

after(async () => {
  await cleanup();
  await mongoose.disconnect();
});

describe("migratePhones", () => {
  it("dry-run detects duplicates and performs zero writes", async () => {
    const usersBefore = await fixtureUserCount();
    const remindersBefore = await fixtureReminderCount();
    const ownersBefore = (
      await Reminder.find({ task: { $regex: /^mig-fixture/ } }).lean()
    ).map((r) => userById(r.userId));

    const summary = await migratePhones({ dryRun: true, scope: SCOPE });

    assert.equal(summary.groups, 4);
    assert.ok(summary.remindersReassigned > 0);
    assert.ok(summary.usersDeleted > 0);

    assert.equal(await fixtureUserCount(), usersBefore);
    assert.equal(await fixtureReminderCount(), remindersBefore);

    const ownersAfter = (
      await Reminder.find({ task: { $regex: /^mig-fixture/ } }).lean()
    ).map((r) => userById(r.userId));

    assert.deepEqual(ownersAfter.sort(), ownersBefore.sort());
  });

  it("live run merges duplicates, preserves reminders, and deletes duplicates", async () => {
    const remindersBefore = await fixtureReminderCount();

    const summary = await migratePhones({ dryRun: false, scope: SCOPE });

    assert.equal(summary.groups, 4);
    assert.equal(summary.usersDeleted, 5);
    assert.ok(summary.remindersReassigned > 0);

    for (const canonical of SCOPE) {
      const users = await User.find({ phoneNumber: canonical }).lean();

      assert.equal(users.length, 1, `one canonical user for ${canonical}`);
    }

    assert.equal(
      await User.countDocuments({
        phoneNumber: { $regex: `^${FIXTURE_PREFIX}` },
      }),
      4,
      "only the four canonical users remain",
    );

    const reminders = await Reminder.find({
      task: { $regex: /^mig-fixture/ },
    }).lean();

    assert.equal(reminders.length, 6, "all fixture reminders preserved");
    assert.equal(await fixtureReminderCount(), remindersBefore);

    const users = await User.find({
      phoneNumber: { $regex: `^${FIXTURE_PREFIX}` },
    }).lean();

    for (const user of users) {
      assert.equal(user.phoneNumber, userById(user.phoneNumber));

      const ownerIds = new Set(
        reminders
          .filter((r) => r.task.includes(`-${user.phoneNumber.slice(-2)}-`))
          .map((r) => userById(r.userId)),
      );

      assert.ok(ownerIds.size <= 1);
    }

    const survivorIds = reminders.map((r) => userById(r.userId));

    for (const canonical of SCOPE) {
      const [survivor] = await User.find({ phoneNumber: canonical }).lean();

      const owned = reminders.filter((r) => r.task.includes(`-${canonical.slice(-2)}-`));

      for (const reminder of owned) {
        assert.equal(userById(reminder.userId), userById(survivor._id));
      }

      if (owned.length > 0) {
        assert.equal(survivorIds.includes(userById(survivor._id)), true);
      }
    }
  });

  it("a second run performs no additional changes", async () => {
    const usersBefore = await fixtureUserCount();
    const remindersBefore = await fixtureReminderCount();

    const summary = await migratePhones({ dryRun: false, scope: SCOPE });

    assert.equal(summary.groups, 0);
    assert.equal(summary.usersUpdated, 0);
    assert.equal(summary.usersDeleted, 0);
    assert.equal(summary.remindersReassigned, 0);
    assert.equal(summary.safetySkipped, 0);

    assert.equal(await fixtureUserCount(), usersBefore);
    assert.equal(await fixtureReminderCount(), remindersBefore);
  });

  it("selectSurvivor prefers reminder owners, then the oldest user", async () => {
    const users = await User.find({
      phoneNumber: { $regex: `^${FIXTURE_PREFIX}` },
    }).lean();

    const counts = {};

    for (const user of users) {
      counts[user._id] = await Reminder.countDocuments({ userId: user._id });
    }

    const survivor = selectSurvivor(users, counts);

    const expected = [...users].sort((a, b) => {
      const aHas = counts[a._id] > 0 ? 1 : 0;
      const bHas = counts[b._id] > 0 ? 1 : 0;

      if (aHas !== bHas) return bHas - aHas;

      return String(a._id).localeCompare(String(b._id));
    })[0];

    assert.equal(userById(survivor._id), userById(expected._id));
  });
});