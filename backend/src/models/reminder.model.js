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
      enum: ["daily", "weekly", "monthly", null],
      default: null,
    },

    status: {
      type: String,
      enum: ["pending", "sent", "completed", "cancelled"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

const Reminder = mongoose.model("Reminder", reminderSchema);

export default Reminder;