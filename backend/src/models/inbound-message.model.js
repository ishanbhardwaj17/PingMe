import mongoose from "mongoose";

const inboundMessageSchema = new mongoose.Schema(
  {
    wamid: {
      type: String,
      required: true,
      unique: true,
    },

    phoneNumber: {
      type: String,
      required: true,
    },

    text: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      required: true,
      default: "received",
      enum: ["received", "processing", "processed", "failed"],
    },

    error: {
      type: String,
      default: null,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    attemptCount: {
      type: Number,
      default: 0,
    },

    lastAttemptAt: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

inboundMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("InboundMessage", inboundMessageSchema);