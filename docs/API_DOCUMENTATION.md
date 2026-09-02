# PingMe API Documentation

## 1. Webhook Verification

### Endpoint

```text
GET /api/webhook
```

### Purpose

Used by Meta to verify the webhook.

### Query Parameters

```text
hub.mode
hub.verify_token
hub.challenge
```

### Success

HTTP 200 with the challenge value.

### Failure

HTTP 403 for an invalid verification token.

## 2. Incoming WhatsApp Webhook

### Endpoint

```text
POST /api/webhook
```

### Example Event

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "changes": [
        {
          "field": "messages",
          "value": {
            "messages": [
              {
                "type": "text",
                "text": {
                  "body": "Remind me to drink water in 2 minutes"
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## 3. Webhook Response

The server should quickly return:

```text
EVENT_RECEIVED
```

with HTTP 200.

This prevents Meta from waiting for reminder processing.

## 4. Incoming Processing

The service extracts:

```js
const phoneNumber = message.from;
const text = message.text.body;
```

Then:

```text
findOrCreateUser()
parseReminderText()
detectRecurrence()
createReminder()
sendWhatsAppMessage()
```

## 5. Outbound WhatsApp Message

The WhatsApp service sends a POST request to:

```text
https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages
```

Request body:

```json
{
  "messaging_product": "whatsapp",
  "to": "PHONE_NUMBER",
  "type": "text",
  "text": {
    "body": "MESSAGE"
  }
}
```

Authorization:

```text
Bearer WHATSAPP_TOKEN
```

## 6. Confirmation Message

Example:

```text
✅ Reminder set

Drink water
```

## 7. Reminder Message

Example:

```text
⏰ Reminder

Drink water
```

## 8. Error Message

Example:

```text
⚠️ Failed to set reminder: Please specify a date and time.
```

## 9. Health Endpoint

A production health endpoint should be added:

```text
GET /health
```

It should report API, MongoDB, and Redis health.

## 10. Future API Endpoints

Although the core product is WhatsApp-first, internal or future API endpoints may include:

```text
GET    /api/reminders
POST   /api/reminders
DELETE /api/reminders/:id
PATCH  /api/reminders/:id
```

These should not be required for normal WhatsApp usage.
