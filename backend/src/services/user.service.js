import User from "../models/user.model.js";

export const findOrCreateUser = async (
    phoneNumber,
    whatsappName = "WhatsApp User"
) => {
    let user = await User.findOne({
        phoneNumber,
    });

    if (!user) {
        user = await User.create({
            phoneNumber,
            whatsappName,
        });

        console.log(
            `New user created: ${phoneNumber}`
        );
    }

    return user;
};