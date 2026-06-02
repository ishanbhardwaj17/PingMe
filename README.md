# PingMe

> **Your day, in one WhatsApp message.**

PingMe is an AI-powered WhatsApp reminder assistant that helps users remember important tasks, deadlines, bills, meetings, and habits without installing another productivity app.

Instead of asking users to open yet another reminder application, PingMe delivers reminders directly through WhatsApp — where user attention already exists.

---

## Overview

People miss tasks not because they don't create reminders, but because they ignore or forget to open reminder apps.

WhatsApp is one of the most frequently used applications in the world. PingMe leverages that existing user behavior by turning WhatsApp into a personal reminder assistant.

Users can simply send messages like:

```text
Remind me to pay electricity bill tomorrow at 6 PM
```

and PingMe will automatically schedule and deliver reminders at the right time.

---

## Problem Statement

Traditional reminder apps suffer from low engagement because users rarely open them after installation.

Common issues include:

- Missing bill payments
- Forgetting appointments
- Missing assignment deadlines
- Forgetting medications
- Poor task organization

PingMe solves this by bringing reminders into the messaging platform users already check every day.

---

#### WhatsApp Reminder Creation

```text
Remind me to pay electricity bill tomorrow at 6 PM
```

#### Recurring Reminders

```text
Take medicine every day at 8 AM
```

```text
Pay rent on the 1st of every month
```

#### Daily Digest

```text
🌅 Good Morning

Today's Schedule

• Team Meeting - 10:00 AM
• Pay Electricity Bill - 1:00 PM
• Gym - 6:00 PM
```

#### Smart Reminder Escalation

```text
Reminder: Pay Electricity Bill
```

If ignored:

```text
Still pending?
```

#### Mark Tasks Complete

```text
Done
```

#### Voice Note Reminders

```text
🎤 Voice Note
      ↓
Speech-to-Text
      ↓
Reminder Created
```

#### OCR-Based Reminder Creation

Users can upload:

- Bills
- Appointment slips
- Flight tickets
- Event invitations

PingMe extracts important dates and automatically creates reminders.

#### AI-Powered Task Categorization

Automatically organize reminders into:

- 💰 Finance
- 🎓 Study
- 💼 Work
- 🏥 Health
- 👨‍👩‍👧 Personal

---

##  System Architecture

```text
                      ┌───────────────────┐
                      │ WhatsApp User     │
                      └─────────┬─────────┘
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ WhatsApp Cloud API       │
                  └─────────┬────────────────┘
                            │
                            ▼
                  ┌──────────────────────────┐
                  │ Webhook Endpoint         │
                  └─────────┬────────────────┘
                            │
                            ▼
                  ┌──────────────────────────┐
                  │ Reminder Service         │
                  └───────┬─────────┬────────┘
                          │         │
                          ▼         ▼
                   MongoDB      BullMQ Queue
                                      │
                                      ▼
                                   Redis
                                      │
                                      ▼
                            Reminder Worker
                                      │
                                      ▼
                          WhatsApp Cloud API
                                      │
                                      ▼
                                   User
```

---

##  Tech Stack

### Backend

- Node.js
- Express.js

### Database

- MongoDB Atlas
- Mongoose

### Queue System

- Redis
- BullMQ

### Messaging Platform

- WhatsApp Cloud API

### AI Features

- OpenAI API / Gemini API
- Whisper API
- Tesseract OCR

### Deployment

- Render / Railway
- MongoDB Atlas
- Upstash Redis

---

## 📂 Project Structure

```text
backend/
│
├── src/
│
├── config/
│   └── db.js
│
├── controllers/
│   ├── reminder.controller.js
│   └── webhook.controller.js
│
├── routes/
│   ├── reminder.routes.js
│   └── webhook.routes.js
│
├── services/
│   ├── reminder.service.js
│   └── whatsapp.service.js
│
├── models/
│   └── reminder.model.js
│
├── queues/
│   └── reminder.queue.js
│
├── workers/
│   └── reminder.worker.js
│
├── middlewares/
│
├── utils/
│
├── app.js
└── server.js

.env
package.json
README.md
```

---

##  Application Flow

### Create Reminder

```text
User
  ↓
Creates Reminder
  ↓
API Request
  ↓
Reminder Stored in MongoDB
  ↓
Job Scheduled in BullMQ
  ↓
Redis Queue
  ↓
Worker Executes
  ↓
WhatsApp Message Sent
```

---

##  API Endpoints

### Create Reminder

```http
POST /api/reminders
```

Request Body

```json
{
  "phoneNumber": "+919999999999",
  "task": "Pay Electricity Bill",
  "reminderTime": "2026-06-15T18:00:00.000Z"
}
```

---

### Get All Reminders

```http
GET /api/reminders
```

---

### Delete Reminder

```http
DELETE /api/reminders/:id
```

---

## 🎯 Engineering Concepts Demonstrated

This project showcases production-grade backend engineering concepts including:

- REST API Development
- MVC Architecture
- Service Layer Pattern
- Event-Driven Architecture
- Background Job Processing
- Distributed Scheduling
- Redis Queues
- Webhook Handling
- Third-Party API Integration
- Natural Language Processing
- OCR Pipelines
- Speech-to-Text Systems
- Scalable Backend Design

---


##  Why PingMe?

Most reminder applications require users to change their behavior.

PingMe works with existing behavior.

Instead of asking users to remember to open a reminder app, PingMe delivers reminders directly to the platform they already use every day.

**No extra apps. No extra effort. Just reminders where your attention already lives.**

---

##  Author

**Ishan Bhardwaj**

Aspiring Backend & Full-Stack Developer passionate about building scalable systems, backend architectures, and real-world software products.

---

## ⭐ Support

If you find this project interesting, consider giving it a star and following its development journey.
