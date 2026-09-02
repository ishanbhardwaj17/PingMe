# PingMe System Architecture

## 1. High-Level Architecture

```text
                    WhatsApp User
                         |
                         v
              Meta WhatsApp Cloud API
                         |
                         v
                  Express Webhook
                         |
                         v
              Incoming Message Service
                    /    |     \
                   /     |      \
                  v      v       v
               User   Parser   Reminder
             Service          Service
                |                |
                v                v
             MongoDB          MongoDB
                                  |
                                  v
                              BullMQ
                                  |
                                  v
                                Redis
                                  |
                                  v
                         Reminder Worker
                                  |
                                  v
                         WhatsApp Service
                                  |
                                  v
                      Meta WhatsApp API
                                  |
                                  v
                                User
```

## 2. Backend Responsibilities

### Controllers

Receive HTTP requests and return HTTP responses.

Current webhook controller:

```text
webhook.controller.js
```

Responsibilities:

- Meta verification
- Extract incoming message
- Return webhook acknowledgement

### Services

Contain business logic.

Examples:

```text
incoming-message.service.js
user.service.js
reminder.service.js
whatsapp.service.js
reminder-delivery.service.js
```

### Models

Represent MongoDB documents.

```text
user.model.js
reminder.model.js
```

### Utilities

Pure or focused processing logic.

```text
parser.js
recurrenceParser.js
```

### Workers

Background processing.

```text
reminder.worker.js
```

## 3. API Process

The API process should not execute delayed reminders directly.

It creates queue jobs and responds to webhook requests.

## 4. Worker Process

The worker is a separate Node.js process.

Development:

```bash
npm run dev
```

and separately:

```bash
node src/workers/reminder.worker.js
```

## 5. Queue Responsibility

MongoDB stores the reminder.

BullMQ stores and executes the delayed job.

The job contains the reminder ID:

```js
{
  reminderId
}
```

The worker retrieves the latest reminder from MongoDB before delivery.

## 6. External Systems

PingMe depends on:

- Meta WhatsApp Cloud API
- MongoDB
- Redis

ngrok is used only for local webhook development.

## 7. Production Architecture

```text
Internet
   |
   v
HTTPS / Load Balancer
   |
   +----> API instance
   +----> API instance
             |
             v
           Redis
             |
      +------+------+
      |             |
   Worker 1      Worker 2
      |             |
      +------+------+
             |
          MongoDB
```

## 8. Design Principles

- WhatsApp-first
- Asynchronous reminder execution
- Persistent source of truth in MongoDB
- Queue-backed background work
- Separate API and worker processes
- User-level data isolation
- Deterministic parsing before introducing an LLM
