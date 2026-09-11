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

    recurrenceAdvancedAt: {
      type: Date,
      default: null,
    },

    recurrenceNextId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reminder",
      default: null,
    },

    recurrenceParentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reminder",
      default: null,
    },

    recurrenceStoppedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: ["pending", "sent", "failed", "cancelled"],
      default: "pending",
    },

    deliveryAttempts: {
      type: Number,
      required: true,
      default: 0,
    },

    deliveredAt: {
      type: Date,
      default: null,
    },

    deliveredMessageId: {
      type: String,
      default: null,
    },

    lastError: {
      type: String,
      default: null,
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

reminderSchema.index(
  { recurrenceParentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      recurrenceParentId: { $type: "objectId" },
    },
  },
);

const Reminder = mongoose.model("Reminder", reminderSchema);

export default Reminder;
