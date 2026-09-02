# PingMe Implementation Plan

## Phase 1: Project Foundation

### Scope

- Node.js project
- Express server
- Environment configuration
- MongoDB connection
- Redis connection

### Verification

- Server starts
- MongoDB connects
- Redis connects

Status: COMPLETE

## Phase 2: User System

### Scope

- User model
- User service
- Automatic user creation using WhatsApp phone number

### Verification

- First message creates user
- Subsequent message finds same user

Status: COMPLETE

## Phase 3: Reminder Engine

### Scope

- Reminder model
- Reminder service
- chrono-node parser
- Recurrence detection

### Verification

Test:

`Remind me to drink water tomorrow at 7pm`

Expected:

- Task extracted
- Correct date/time extracted
- Reminder stored

Status: COMPLETE

## Phase 4: BullMQ Scheduling

### Scope

- Redis-backed queue
- Delayed reminder jobs
- Worker process

### Verification

Create a reminder two minutes into the future.

Expected:

- Job enters queue
- Worker executes at correct time
- Reminder is delivered

Status: COMPLETE

## Phase 5: WhatsApp Outbound

### Scope

- WhatsApp Cloud API service
- Confirmation messages
- Reminder delivery

### Verification

Expected:

```text
PingMe confirmation -> WhatsApp
Reminder -> WhatsApp
```

Status: COMPLETE

## Phase 6: Webhook

### Scope

- Meta webhook verification
- Incoming POST event handling
- ngrok development tunnel

### Verification

Meta test event reaches:

```text
Meta -> ngrok -> Express
```

Status: COMPLETE

## Phase 7: Real End-to-End WhatsApp Flow

### Scope

Test:

`Remind me to drink water in 2 minutes`

### Verification

1. Real WhatsApp message reaches webhook.
2. Sender phone number is extracted.
3. User is found/created.
4. Parser extracts task and time.
5. Reminder is stored.
6. BullMQ job is scheduled.
7. Confirmation reaches WhatsApp.
8. Worker sends reminder after two minutes.
9. Reminder becomes `sent`.

Status: CURRENT MILESTONE

## Phase 8: Command Router

Implement:

```text
CREATE_REMINDER
LIST_REMINDERS
SHOW_DIGEST
DELETE_REMINDER
HELP
UNKNOWN
```

Verification:

Each command produces the expected response.

## Phase 9: Daily Digest

Implement:

- Digest scheduling
- Upcoming reminder query
- Digest message generation
- WhatsApp delivery

Verification:

User receives a daily reminder summary.

## Phase 10: Conversational State

Support follow-up messages.

Example:

```text
User: Remind me tomorrow
Bot: What should I remind you about?
User: Submit assignment
```

Store short-lived conversation state.

## Phase 11: Reliability

Implement:

- Webhook idempotency
- Duplicate event detection
- BullMQ retry configuration
- Failed delivery handling
- Graceful shutdown
- Health checks
- Structured logs

## Phase 12: Production Security

Implement:

- Rate limiting
- Security headers
- Input validation
- Secret management
- Production CORS configuration
- Webhook hardening

## Phase 13: Testing

Cover:

- Parser
- Recurrence
- User service
- Reminder service
- Webhook
- Worker
- WhatsApp service
- End-to-end reminder flow

## Phase 14: Deployment

Deploy:

```text
API server
Worker
Redis
MongoDB
```

Configure:

- HTTPS
- Meta webhook
- Environment variables
- Monitoring
- Logging

## Phase Completion Rule

Do not move to the next phase until:

1. Implementation is complete.
2. Manual verification passes.
3. Automated tests pass where applicable.
4. No known blocking issue remains.
5. Git commit is created.
