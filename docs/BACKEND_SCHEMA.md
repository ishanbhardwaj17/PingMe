# PingMe Backend Schema

## 1. User Model

The user is identified by WhatsApp phone number.

Conceptual schema:

```js
{
  phoneNumber: String,
  createdAt: Date,
  updatedAt: Date
}
```

The phone number should be unique.

## 2. Reminder Model

Current schema:

```js
{
  phoneNumber: {
    type: String,
    required: true
  },

  task: {
    type: String,
    required: true
  },

  reminderTime: {
    type: Date,
    required: true
  },

  isRecurring: {
    type: Boolean,
    default: false
  },

  recurrencePattern: {
    type: String,
    enum: ["daily", "weekly", "monthly", null],
    default: null
  },

  status: {
    type: String,
    enum: [
      "pending",
      "sent",
      "failed",
      "completed",
      "cancelled"
    ],
    default: "pending"
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }
}
```

Timestamps are enabled.

## 3. Field Description

| Field | Purpose |
|---|---|
| phoneNumber | WhatsApp destination |
| task | Reminder content |
| reminderTime | Time at which job should execute |
| isRecurring | Whether another occurrence should be generated |
| recurrencePattern | Daily, weekly, or monthly |
| status | Reminder lifecycle state |
| userId | Owner of reminder |
| createdAt | Creation timestamp |
| updatedAt | Last modification timestamp |

## 4. Relationships

```text
User
 |
 | 1:N
 v
Reminder
```

One user can have many reminders.

## 5. Status Lifecycle

```text
pending
   |
   +----> sent
   |
   +----> failed
   |
   +----> cancelled
   |
   +----> completed
```

## 6. Recurring Reminder Ownership

When a recurring reminder creates the next reminder, the same `userId` must be passed.

```js
await createReminder({
  phoneNumber: reminder.phoneNumber,
  task: reminder.task,
  reminderTime: nextDate,
  isRecurring: true,
  recurrencePattern: reminder.recurrencePattern,
  userId: reminder.userId
});
```

Without `userId`, the Mongoose validation fails because the field is required.

## 7. Recommended Indexes

Production indexes should include:

```text
User.phoneNumber
Reminder.userId + Reminder.status
Reminder.reminderTime
```

These support common user and worker queries.

## 8. Data Isolation

Every reminder query should be scoped to the authenticated or identified user.

Example concept:

```js
Reminder.find({
  userId: user._id,
  status: "pending"
});
```

A phone number should never be allowed to access another user's reminders.
