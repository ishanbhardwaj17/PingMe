# PingMe Testing Plan

## 1. Foundation Tests

Verify:

- API starts
- MongoDB connects
- Redis connects
- Environment variables load

Expected:

```text
Server running on port 5000
MongoDB Connected
Redis Connected
```

## 2. Parser Tests

### Valid

```text
Remind me to drink water tomorrow at 7pm
```

Expected:

```text
task = drink water
reminderTime = tomorrow at 7pm
```

### Relative Time

```text
Remind me to drink water in 2 minutes
```

Expected:

- Task = drink water
- Reminder time approximately two minutes from parsing time

### Invalid

```text
this is a text message
```

Expected:

```text
Could not understand date/time
```

## 3. Recurrence Tests

Test:

```text
Remind me to exercise every day at 8am
```

Expected:

```text
isRecurring = true
recurrencePattern = daily
```

Also test:

- every week
- every month

## 4. User Tests

### New User

Send first message.

Expected:

- User created.

### Existing User

Send second message.

Expected:

- Existing user reused.
- No duplicate user.

## 5. Reminder Database Test

After creating a reminder, verify:

```text
phoneNumber
task
reminderTime
userId
status = pending
```

## 6. Queue Test

Create a reminder in the near future.

Verify:

```text
BullMQ job created
```

Then verify worker receives the job.

## 7. Worker Test

Expected logs:

```text
Reminder sent: <task>
Job <id> completed
```

Expected database:

```text
status = sent
```

## 8. WhatsApp Test

Verify:

1. Confirmation message arrives.
2. Reminder message arrives.
3. Message text is correct.

## 9. Webhook Test

Meta:

```text
Meta -> ngrok -> Express
```

Verify the request appears in ngrok inspector.

Verify API logs the incoming event.

## 10. End-to-End Test

Send from WhatsApp:

```text
Remind me to drink water in 2 minutes
```

Expected:

```text
WhatsApp
  -> Meta
  -> ngrok
  -> Express
  -> Parser
  -> MongoDB
  -> BullMQ
  -> Worker
  -> WhatsApp
```

Expected user experience:

```text
User: Remind me to drink water in 2 minutes

PingMe: ✅ Reminder set

Drink water

[2 minutes later]

PingMe: ⏰ Reminder

Drink water
```

## 11. Failure Tests

Test:

- Invalid date
- Missing task
- WhatsApp API failure
- MongoDB unavailable
- Redis unavailable
- Worker stopped
- Duplicate webhook event

## 12. Recurring Test

Create a recurring reminder.

Verify:

1. First occurrence is sent.
2. Current reminder becomes `sent`.
3. Next reminder is created.
4. Next reminder contains the same `userId`.
5. Next BullMQ job is scheduled.

## 13. Final Acceptance Checklist

- [ ] Webhook verified
- [ ] Real WhatsApp message received
- [ ] User created
- [ ] Reminder created
- [ ] Confirmation delivered
- [ ] BullMQ job scheduled
- [ ] Worker executed
- [ ] Reminder delivered
- [ ] Status changed to sent
- [ ] Recurrence works
- [ ] Invalid input handled
- [ ] Failure state handled
- [ ] Duplicate events handled
