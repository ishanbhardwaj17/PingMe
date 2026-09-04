import User from "../models/user.model.js";
import { normalizePhoneNumber } from "../utils/phone.js";

export const findOrCreateUser = async (
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
        } catch (error) {
            // Concurrent creation of the same normalized number: the unique
            // phoneNumber index rejects the loser. Re-fetch the winner.
            if (error.code === 11000) {
                user = await User.findOne({
                    phoneNumber: canonicalPhone,
                });

                if (user) {
                    return user;
                }
            }

            throw error;
        }
    }

    return user;
};