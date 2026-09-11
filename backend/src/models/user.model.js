import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
    {
        phoneNumber: {
            type: String,
            required: true,
            unique: true,
        },

        whatsappName: {
            type: String,
            default: "WhatsApp User",
        },

        timezone: {
            type: String,
            default: "Asia/Kolkata",
        },

        digestEnabled: {
            type: Boolean,
            default: false,
        },

        lastDigestSentDate: {
            type: String,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

export default mongoose.model("User", userSchema);