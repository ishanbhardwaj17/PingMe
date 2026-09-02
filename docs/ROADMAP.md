# PingMe Roadmap

## Completed

### Foundation

- Node.js backend
- Express
- MongoDB
- Mongoose
- Redis
- BullMQ

### Reminder Engine

- Reminder model
- Natural-language date/time parsing
- Recurrence detection
- Reminder creation

### Background Processing

- BullMQ delayed jobs
- Separate reminder worker
- Reminder delivery
- Delivery status updates
- Recurring reminder generation

### WhatsApp

- WhatsApp Cloud API
- Outbound message delivery
- Meta webhook verification
- Incoming webhook
- ngrok development tunnel

### Identity

- Phone-number based user identity
- Automatic user creation

## Current Milestone

Complete the real WhatsApp end-to-end flow:

```text
Real WhatsApp message
        |
        v
Webhook
        |
        v
Parser
        |
        v
MongoDB
        |
        v
BullMQ
        |
        v
Worker
        |
        v
WhatsApp reminder
```

## Next Milestone

Build the command router:

```text
CREATE_REMINDER
LIST_REMINDERS
SHOW_DIGEST
DELETE_REMINDER
HELP
UNKNOWN
```

## Following Milestones

### Daily Digest

Automatically send a summary of upcoming reminders.

### Conversational State

Support multi-message conversations.

### Reminder Management

Add:

- Edit
- Delete
- Cancel
- Snooze

### WhatsApp UX

Add:

- Interactive buttons
- Lists
- Quick actions

### Reliability

Add:

- Idempotency
- Retry policies
- Dead-letter handling
- Graceful shutdown
- Health checks
- Monitoring

### Timezones

Store and apply user timezone.

### AI

Only after deterministic command routing is stable.

Potential architecture:

```text
Message
   |
   v
LLM Intent Classifier
   |
   v
Structured Intent
   |
   v
Deterministic Command Service
   |
   v
Database / Queue
```

The LLM should not directly perform database mutations.

## Long-Term Positioning

PingMe should be positioned as:

> A conversational reminder assistant that lives inside WhatsApp.

It is not simply a CRUD reminder application.

Technical highlights:

- WhatsApp Cloud API
- Webhook-driven architecture
- Natural-language parsing
- MongoDB
- Redis
- BullMQ
- Background workers
- Recurring job generation
- Phone-number identity
- User-specific data isolation
