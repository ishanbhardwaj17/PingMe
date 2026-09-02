# PingMe Application Flow

## 1. Complete Reminder Flow

```text
User
 |
 | "Remind me to drink water in 2 minutes"
 v
WhatsApp
 |
 v
Meta WhatsApp Cloud API
 |
 v
POST /api/webhook
 |
 v
receiveMessage()
 |
 v
handleIncomingMessage()
 |
 +--> findOrCreateUser()
 |
 +--> parseReminderText()
 |
 +--> detectRecurrence()
 |
 +--> createReminder()
 |
 +--> BullMQ schedules job
 |
 +--> send confirmation
 |
 v
User receives:
"Reminder set"
```

## 2. Reminder Execution Flow

```text
BullMQ delayed job
       |
       v
Reminder Worker
       |
       v
Find reminder in MongoDB
       |
       v
sendReminder()
       |
       v
WhatsApp Cloud API
       |
       v
User receives reminder
       |
       v
MongoDB status = sent
```

## 3. Recurring Reminder Flow

```text
Recurring reminder
       |
       v
Worker executes
       |
       v
Send reminder
       |
       v
Mark current reminder sent
       |
       v
Calculate next occurrence
       |
       v
Create next reminder
       |
       v
Schedule next BullMQ job
```

## 4. Invalid Message Flow

```text
User message
     |
     v
Parser
     |
     X
No date/time detected
     |
     v
Error
     |
     v
WhatsApp error response
```

Example:

`Please specify a date and time. Example: Remind me to go gym tomorrow at 7pm`

## 5. User Identity Flow

```text
WhatsApp phone number
        |
        v
findOrCreateUser()
        |
   +----+----+
   |         |
Exists     Missing
   |         |
   |         v
   |      Create user
   |         |
   +----+----+
        |
        v
Return user
```

## 6. Daily Digest Flow

Planned flow:

```text
Scheduled digest job
       |
       v
Find user's upcoming reminders
       |
       v
Build digest message
       |
       v
WhatsApp Cloud API
       |
       v
User receives daily summary
```

## 7. Planned Command Router

Incoming messages should eventually be classified into:

```text
CREATE_REMINDER
LIST_REMINDERS
SHOW_DIGEST
DELETE_REMINDER
HELP
UNKNOWN
```

The command router should run before command-specific services.

## 8. Future Conversational Flow

```text
User
 |
 v
Intent Detection
 |
 +--> Create
 +--> List
 +--> Delete
 +--> Help
 +--> Digest
 |
 v
Command Service
 |
 v
MongoDB / Queue
 |
 v
WhatsApp response
```
