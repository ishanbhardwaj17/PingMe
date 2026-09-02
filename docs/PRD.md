# PingMe Product Requirements Document (PRD)

## 1. Product Overview

PingMe is a WhatsApp-first conversational reminder assistant.

Users create and manage reminders by sending natural-language messages through WhatsApp. There is no login or signup flow. A user's WhatsApp phone number acts as the primary identity.

Example:

> Remind me to drink water in 2 minutes

PingMe parses the message, stores the reminder, schedules background execution, and sends the reminder back through WhatsApp.

## 2. Problem Statement

Traditional reminder applications require users to open an application, navigate a UI, create a reminder, and later remember to check the application.

PingMe removes that friction by placing reminders inside WhatsApp, where users already communicate.

## 3. Product Goal

Build a reliable conversational reminder system that allows a user to:

- Create reminders using natural language
- Receive reminders through WhatsApp
- Create recurring reminders
- View existing reminders
- Delete or cancel reminders
- Receive a daily digest
- Use the service without traditional account registration

## 4. Target User

Primary users are people who already use WhatsApp and want a low-friction way to remember tasks, events, and routines.

## 5. Core User Stories

### Create Reminder

As a user, I want to send a natural-language message so that PingMe can create a reminder.

Example:

`Remind me to call mom tomorrow at 8pm`

### Receive Reminder

As a user, I want PingMe to send me a WhatsApp message when the reminder is due.

### Recurring Reminder

As a user, I want to create daily, weekly, or monthly reminders.

Example:

`Remind me to take my medicine every day at 9am`

### List Reminders

As a user, I want to see my pending reminders.

### Delete Reminder

As a user, I want to cancel a reminder without using a separate application.

### Daily Digest

As a user, I want a summary of my upcoming reminders.

### Help

As a user, I want PingMe to explain supported commands.

## 6. Functional Requirements

### FR-1 User Identification

Users are automatically identified using their WhatsApp phone number.

### FR-2 User Creation

If a phone number does not exist, PingMe creates a user automatically.

### FR-3 Reminder Parsing

The system must extract:

- Task
- Date
- Time
- Recurrence when applicable

Chrono-node is used for natural-language date/time parsing.

### FR-4 Reminder Storage

Every reminder must contain:

- Phone number
- User ID
- Task
- Reminder time
- Recurrence information
- Status
- Timestamps

### FR-5 Scheduling

BullMQ and Redis must schedule reminder jobs.

### FR-6 Delivery

The reminder worker sends the reminder through the WhatsApp Cloud API.

### FR-7 Delivery Status

The reminder status must transition appropriately:

`pending -> sent`

Failures must be represented by:

`pending -> failed`

### FR-8 Recurrence

Supported recurrence patterns:

- Daily
- Weekly
- Monthly

After a recurring reminder is delivered, the next occurrence must be created.

### FR-9 Error Feedback

If a message cannot be parsed, the user must receive a useful WhatsApp error message.

### FR-10 User Isolation

A user must only be able to access their own reminders.

## 7. Non-Functional Requirements

### Reliability

Reminder delivery should continue even when the API process is not executing the reminder itself.

### Performance

Webhook requests should acknowledge Meta quickly and process business logic asynchronously.

### Security

Secrets must be stored in environment variables.

Webhook verification must validate the configured verification token.

### Scalability

The API and worker must be independently scalable.

### Maintainability

Business logic should remain separated into controllers, services, models, utilities, and workers.

## 8. MVP Scope

Included:

- WhatsApp webhook
- User auto-creation
- Natural-language reminder creation
- MongoDB persistence
- Redis
- BullMQ
- Reminder worker
- WhatsApp reminder delivery
- Daily/weekly/monthly recurrence
- Basic error handling

## 9. Out of Scope for Initial MVP

- Web dashboard
- Email reminders
- SMS reminders
- Mobile application
- AI-generated responses
- Complex calendar integrations

## 10. Future Scope

- Interactive WhatsApp buttons
- Better conversational state
- Timezone management
- Reminder editing
- Snooze
- Natural-language listing and deletion
- Calendar integrations
- Analytics
- LLM-based intent classification
- Production observability

## 11. MVP Acceptance Criteria

The MVP is successful when:

1. A WhatsApp message reaches the webhook.
2. PingMe identifies the sender.
3. A reminder is created in MongoDB.
4. A BullMQ job is scheduled.
5. The user receives a confirmation.
6. The worker executes the job at the correct time.
7. WhatsApp receives the reminder.
8. The reminder status becomes `sent`.
9. Recurring reminders create their next occurrence.
10. Invalid messages receive a useful error response.
