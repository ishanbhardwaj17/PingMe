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