import User from "../models/user.model.js";
import { normalizePhoneNumber } from "../utils/phone.js";
import { isValidTimezone } from "../utils/timezone.js";

/**
 * Set the user's IANA timezone. The value must pass Intl validation; the
 * stored timezone is never corrupted by an invalid value.
 *
 * @returns {Promise<{updated: boolean, timezone: string|null}>}
 */
export const setUserTimezone = async (userId, timezone) => {
  const cleaned = timezone?.trim();

  if (!isValidTimezone(cleaned)) {
    return { updated: false, timezone: null };
  }

  await User.updateOne({ _id: userId }, { $set: { timezone: cleaned } });

  return { updated: true, timezone: cleaned };
};

/**
 * Enable or disable the user's morning digest.
 */
export const setDigestEnabled = async (userId, enabled) => {
  await User.updateOne(
    { _id: userId },
    { $set: { digestEnabled: Boolean(enabled) } },
  );

  return Boolean(enabled);
};

/**
 * Resolve a user by canonical phone number, creating it when absent.
 *
 * @returns {Promise<{ user: object, isNew: boolean }>} isNew is true only
 *   when this call created the user (first contact).
 */
export const resolveUser = async (
    phoneNumber,
    whatsappName = "WhatsApp User"
) => {
    const canonicalPhone = normalizePhoneNumber(phoneNumber);

    let user = await User.findOne({
        phoneNumber: canonicalPhone,
    });

    if (!user) {
        try {
            user = await User.create({
                phoneNumber: canonicalPhone,
                whatsappName,
            });

            console.log(
                `New user created: ${canonicalPhone}`
            );

            return { user, isNew: true };
        } catch (error) {
            // Concurrent creation of the same normalized number: the unique
            // phoneNumber index rejects the loser. Re-fetch the winner.
            if (error.code === 11000) {
                user = await User.findOne({
                    phoneNumber: canonicalPhone,
                });

                if (user) {
                    return { user, isNew: false };
                }
            }

            throw error;
        }
    }

    return { user, isNew: false };
};

export const findOrCreateUser = async (
    phoneNumber,
    whatsappName = "WhatsApp User"
) => {
    const { user } = await resolveUser(phoneNumber, whatsappName);

    return user;
};