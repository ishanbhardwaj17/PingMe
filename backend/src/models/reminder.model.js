import mongoose from "mongoose";

const reminderSchema = new mongoose.Schema(
  {
    phoneNumber: {
      type: String,
      required: true,
    },

    task: {
      type: String,
      required: true,
    },

    reminderTime: {
      type: Date,
      required: true,
    },

    isRecurring: {
      type: Boolean,
      default: false,
    },

    recurrencePattern: {
      type: String,
      enum: [
        "daily",
        "weekly",
        "monthly",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        null,
      ],
      default: null,
    },

    recurrenceAnchorDay: {
      type: Number,
      min: 1,
      max: 31,
      default: null,
    },

    status: {
      type: String,
      enum: ["pending", "sent", "failed", "cancelled"],
      default: "pending",
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

const Reminder = mongoose.model("Reminder", reminderSchema);

export default Reminder;
