# PingMe Technical Requirements Document (TRD)

## 1. Architecture

```text
WhatsApp User
    |
    v
Meta WhatsApp Cloud API
    |
    v
POST /api/webhook
    |
    v
Webhook Controller
    |
    v
Incoming Message Service
    |
    +--> User Service --> MongoDB
    |
    +--> Parser
    |
    +--> Reminder Service --> MongoDB
    |
    +--> BullMQ --> Redis
    |
    +--> WhatsApp Service --> Meta API

Redis
    |
    v
BullMQ Reminder Worker
    |
    v
MongoDB
    |
    v
WhatsApp Cloud API
    |
    v
User
```

## 2. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js |
| API | Express |
| Database | MongoDB |
| ODM | Mongoose |
| Queue | BullMQ |
| Queue Backend | Redis |
| Date Parsing | chrono-node |
| Messaging | WhatsApp Cloud API |
| Tunnel | ngrok |
| Language | JavaScript / ES Modules |

## 3. Process Model

PingMe has separate runtime processes.

### API Server

Responsible for:

- Webhook verification
- Receiving WhatsApp events
- Parsing commands
- Creating users
- Creating reminders
- Sending confirmations

### Reminder Worker

Responsible for:

- Processing BullMQ jobs
- Loading reminders
- Sending due reminders
- Updating delivery status
- Creating the next recurring occurrence

### Redis

Responsible for BullMQ queue state and delayed jobs.

### MongoDB

Responsible for persistent application data.

## 4. Environment Variables

```env
MONGO_URI=mongodb://localhost:27017/pingme
PORT=5000
WHATSAPP_TOKEN=<secret>
WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
WHATSAPP_VERIFY_TOKEN=pingme_token
```

Never commit the real WhatsApp token.

## 5. Webhook Design

### Verification

`GET /api/webhook`

Meta sends:

- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

The server validates the verification token and returns the challenge.

### Incoming Event

`POST /api/webhook`

The server extracts:

- Sender phone number
- Message type
- Text body

The webhook returns HTTP 200 quickly.

Business processing continues asynchronously.

## 6. WhatsApp Outbound API

PingMe sends text messages using the WhatsApp Cloud API.

Endpoint pattern:

```text
https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages
```

Authorization uses:

```text
Bearer WHATSAPP_TOKEN
```

## 7. Queue Design

Queue name:

```text
reminders
```

Each job contains at minimum:

```js
{
  reminderId
}
```

The reminder itself remains the source of truth in MongoDB.

## 8. Error Handling

Incoming processing errors must:

1. Be logged.
2. Attempt to send an error response to the user.
3. Propagate the original error.

Worker delivery errors must:

1. Mark the reminder as `failed`.
2. Log the failure.
3. Rethrow the error so BullMQ can process the failed job according to configured retry behavior.

## 9. Webhook Reliability

The webhook should not wait for reminder processing before responding to Meta.

Current approach:

```js
handleIncomingMessage(phoneNumber, text).catch(...)
res.status(200).send("EVENT_RECEIVED");
```

Production improvement:

- Store Meta message IDs
- Implement idempotency
- Ignore duplicate webhook events
- Add structured logging
- Add retry policies

## 10. Scalability

The API and workers can scale independently.

Example:

```text
Load Balancer
      |
      +--> API Server 1
      +--> API Server 2
      |
      v
Redis
      |
      +--> Worker 1
      +--> Worker 2
      |
      v
MongoDB
```

BullMQ prevents multiple workers from processing the same job simultaneously under normal queue semantics.

## 11. Security Requirements

- Store secrets in environment variables.
- Never log access tokens.
- Validate webhook verification.
- Validate incoming message structure.
- Restrict user data access by user identity.
- Add rate limiting before production.
- Add security headers before production.
- Validate all external input.
