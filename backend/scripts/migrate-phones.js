import "dotenv/config";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import User from "../src/models/user.model.js";
import Reminder from "../src/models/reminder.model.js";
import { normalizePhoneNumber } from "../src/utils/phone.js";

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Deterministic canonical-user selection within a duplicate group:
 * 1. Users that own reminders are preferred.
 * 2. Otherwise (or within reminder owners), the oldest user wins.
 * 3. Ties broken by earliest _id.
 */
export const selectSurvivor = (group, reminderCounts) =>
  [...group].sort((a, b) => {
    const aHas = reminderCounts[a._id] > 0 ? 1 : 0;
    const bHas = reminderCounts[b._id] > 0 ? 1 : 0;

    if (aHas !== bHas) return bHas - aHas;

    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();

    if (aTime !== bTime) return aTime - bTime;

    return String(a._id).localeCompare(String(b._id));
  })[0];

/**
 * Merge users whose phone numbers normalize to the same canonical value.
 *
 * @param {object} options
 * @param {boolean} [options.dryRun] true = report only, zero writes
 * @param {string[]} [options.scope] canonical numbers to restrict processing
 *   to (used by tests); when omitted every group is processed
 */
export const migratePhones = async ({ dryRun = DRY_RUN, scope = null } = {}) => {
  const users = await User.find({}).sort({ createdAt: 1, _id: 1 }).lean();

  const groups = new Map();

  for (const user of users) {
    let canonical;

    try {
      canonical = normalizePhoneNumber(user.phoneNumber);
    } catch {
      console.warn(
        `SKIP: user ${user._id} has unparseable phone "${user.phoneNumber}"`,
      );
      continue;
    }

    if (!groups.has(canonical)) {
      groups.set(canonical, []);
    }

    groups.get(canonical).push(user);
  }

  const summary = {
    groups: 0,
    usersUpdated: 0,
    usersDeleted: 0,
    remindersReassigned: 0,
    safetySkipped: 0,
  };

  const log = (message) =>
    console.log(`${dryRun ? "[DRY-RUN] " : ""}${message}`);

  for (const [canonical, group] of groups) {
    if (scope && !scope.includes(canonical)) {
      continue;
    }

    if (group.length === 1) {
      const user = group[0];

      if (user.phoneNumber !== canonical) {
        summary.groups++;
        summary.usersUpdated++;

        log(`UPDATE user ${user._id}: "${user.phoneNumber}" -> "${canonical}"`);

        if (!dryRun) {
          await User.updateOne(
            { _id: user._id },
            { $set: { phoneNumber: canonical } },
          );
        }
      }

      continue;
    }

    summary.groups++;

    const reminderCounts = {};

    for (const user of group) {
      reminderCounts[user._id] = await Reminder.countDocuments({
        userId: user._id,
      });
    }

    const survivor = selectSurvivor(group, reminderCounts);
    const duplicates = group.filter(
      (user) => user._id.toString() !== survivor._id.toString(),
    );

    for (const duplicate of duplicates) {
      const count = reminderCounts[duplicate._id];

      summary.remindersReassigned += count;

      log(
        `REASSIGN ${count} reminder(s) from ${duplicate._id} -> ${survivor._id} (canonical "${canonical}")`,
      );

      if (dryRun) {
        summary.usersDeleted++;

        log(`DELETE user ${duplicate._id} ("${duplicate.phoneNumber}")`);

        continue;
      }

      if (count > 0) {
        await Reminder.updateMany(
          { userId: duplicate._id },
          { $set: { userId: survivor._id } },
        );
      }

      const remaining = await Reminder.countDocuments({
        userId: duplicate._id,
      });

      if (remaining === 0) {
        summary.usersDeleted++;

        log(`DELETE user ${duplicate._id} ("${duplicate.phoneNumber}")`);

        await User.deleteOne({ _id: duplicate._id });
      } else {
        summary.safetySkipped++;

        console.error(
          `SAFETY: user ${duplicate._id} still owns ${remaining} reminder(s); NOT deleting.`,
        );
      }
    }

    // Update the survivor last: deleting duplicates frees the canonical
    // phoneNumber for the unique index before the survivor takes it over.
    if (survivor.phoneNumber !== canonical) {
      summary.usersUpdated++;

      log(
        `UPDATE survivor ${survivor._id}: "${survivor.phoneNumber}" -> "${canonical}"`,
      );

      if (!dryRun) {
        await User.updateOne(
          { _id: survivor._id },
          { $set: { phoneNumber: canonical } },
        );
      }
    }
  }

  console.log("\nSummary:", JSON.stringify(summary, null, 2));

  return summary;
};

if (isDirectRun) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);

    console.log(
      `Migration mode: ${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE"}`,
    );

    await migratePhones({ dryRun: DRY_RUN });

    await mongoose.disconnect();
  })().catch((error) => {
    console.error("Migration failed:", error.message);
    process.exit(1);
  });
}