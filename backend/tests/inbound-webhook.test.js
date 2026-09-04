import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import app from "../src/app.js";
import InboundMessage from "../src/models/inbound-message.model.js";
import Reminder from "../src/models/reminder.model.js";
import redisConnection from "../src/config/redis.js";
import {
  claimInboundMessage,
  markInboundMessageProcessing,
  markInboundMessageProcessed,
  markInboundMessageFailed,
} from "../src/services/inbound-message.service.js";
import { handleIncomingMessage } from "../src/services/incoming-message.service.js";

const FIXTURE_PHONE = "9199998820";
const FIXTURE_TASK = "inbound-fixture";

const cleanup = async () => {
  await InboundMessage.deleteMany({ wamid: { $regex: /^WAMID-75B2A-/ } });
  await Reminder.deleteMany({ task: { $regex: /^inbound-fixture/ } });
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await cleanup();
});

afterEach(cleanup);

after(async () => {
  await cleanup();
  await redisConnection.quit().catch(() => {});
  await mongoose.disconnect();
});

describe("claimInboundMessage", () => {
  it("claims a message with received status and a 72-hour expiry", async () => {
    const record = await claimInboundMessage({
      wamid: "WAMID-75B2A-claim-1",
      phoneNumber: "91999988201",
      text: "Remind me to test tomorrow at 9am",
    });

    assert.equal(record.status, "received");
    assert.equal(record.phoneNumber, "91999988201");
    assert.equal(record.attemptCount, 0);

    const expectedExpiry = Date.now() + 72 * 60 * 60 * 1000;

    assert.ok(
      Math.abs(record.expiresAt.getTime() - expectedExpiry) < 60_000,
      "expiresAt should be ~72h after creation",
    );
  });

  it("returns null for a sequential duplicate and records the attempt", async () => {
    const wamid = "WAMID-75B2A-claim-2";

    await claimInboundMessage({
      wamid,
      phoneNumber: "91999988201",
      text: "Remind me to test tomorrow at 9am",
    });

    const duplicate = await claimInboundMessage({
      wamid,
      phoneNumber: "91999988201",
      text: "Remind me to test tomorrow at 9am",
    });

    assert.equal(duplicate, null);

    const record = await InboundMessage.findOne({ wamid });

    assert.equal(record.attemptCount, 1);
    assert.ok(record.lastAttemptAt);
  });

  it("claims exactly one record under concurrent duplicates", async () => {
    const wamid = "WAMID-75B2A-claim-3";

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimInboundMessage({
          wamid,
          phoneNumber: "91999988201",
          text: "Remind me to test tomorrow at 9am",
        }),
      ),
    );

    const winners = results.filter((record) => record !== null);

    assert.equal(winners.length, 1);
    assert.equal(await InboundMessage.countDocuments({ wamid }), 1);

    const record = await InboundMessage.findOne({ wamid });

    assert.equal(record.attemptCount, 4, "four losers observed");
    assert.ok(record.lastAttemptAt);
  });
});

describe("inbound message state machine", () => {
  it("transitions received -> processing -> processed", async () => {
    const record = await claimInboundMessage({
      wamid: "WAMID-75B2A-state-1",
      phoneNumber: "91999988201",
      text: "Remind me to test tomorrow at 9am",
    });

    await markInboundMessageProcessing(record._id);

    const processing = await InboundMessage.findById(record._id);

    assert.equal(processing.status, "processing");
    assert.ok(processing.processingStartedAt);
    assert.equal(processing.processedAt, null);

    await markInboundMessageProcessed(record._id);

    const processed = await InboundMessage.findById(record._id);

    assert.equal(processed.status, "processed");
    assert.ok(processed.processedAt);
    assert.ok(processed.processingStartedAt);
  });

  it("transitions received -> processing -> failed with a stored error", async () => {
    const record = await claimInboundMessage({
      wamid: "WAMID-75B2A-state-2",
      phoneNumber: "91999988201",
      text: "this is not a reminder",
    });

    await markInboundMessageProcessing(record._id);
    await markInboundMessageFailed(
      record._id,
      new Error("Could not understand date/time"),
    );

    const failed = await InboundMessage.findById(record._id);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Could not understand date/time");
    assert.ok(failed.processedAt);
  });
});

describe("handleIncomingMessage duplicate suppression", () => {
  const VALID_TEXT = "Remind me to do inbound fixture tomorrow at 9am";

  it("does not run the pipeline for an already processed wamid", async () => {
    const wamid = "WAMID-75B2A-dup-processed";

    const record = await claimInboundMessage({
      wamid,
      phoneNumber: "91999988201",
      text: VALID_TEXT,
    });

    await markInboundMessageProcessing(record._id);
    await markInboundMessageProcessed(record._id);

    const result = await handleIncomingMessage(wamid, "91999988201", VALID_TEXT);

    assert.equal(result, null);
    assert.equal(await Reminder.countDocuments({ task: FIXTURE_TASK }), 0);
    assert.equal(
      (await InboundMessage.findOne({ wamid })).attemptCount,
      1,
    );
  });

  it("does not run the pipeline or resend errors for an already failed wamid", async () => {
    const wamid = "WAMID-75B2A-dup-failed";

    const record = await claimInboundMessage({
      wamid,
      phoneNumber: "91999988201",
      text: VALID_TEXT,
    });

    await markInboundMessageProcessing(record._id);
    await markInboundMessageFailed(record._id, new Error("boom"));

    const result = await handleIncomingMessage(wamid, "91999988201", VALID_TEXT);

    assert.equal(result, null);
    assert.equal(await Reminder.countDocuments({ task: FIXTURE_TASK }), 0);

    const stored = await InboundMessage.findOne({ wamid });

    assert.equal(stored.status, "failed");
    assert.equal(stored.attemptCount, 1);
  });

  it("does not run the pipeline while the record is processing", async () => {
    const wamid = "WAMID-75B2A-dup-processing";

    const record = await claimInboundMessage({
      wamid,
      phoneNumber: "91999988201",
      text: VALID_TEXT,
    });

    await markInboundMessageProcessing(record._id);

    const result = await handleIncomingMessage(wamid, "91999988201", VALID_TEXT);

    assert.equal(result, null);
    assert.equal(await Reminder.countDocuments({ task: FIXTURE_TASK }), 0);
  });

  it("does not reclaim a received (unstarted) record", async () => {
    const wamid = "WAMID-75B2A-dup-received";

    await claimInboundMessage({
      wamid,
      phoneNumber: "91999988201",
      text: VALID_TEXT,
    });

    const result = await handleIncomingMessage(wamid, "91999988201", VALID_TEXT);

    assert.equal(result, null);
    assert.equal(await Reminder.countDocuments({ task: FIXTURE_TASK }), 0);

    const stored = await InboundMessage.findOne({ wamid });

    assert.equal(stored.status, "received");
  });
});

describe("webhook payload handling", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
  });

  it("acks non-text events with 200 and creates no record", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                statuses: [{ id: "wamid.status.1", status: "sent" }],
              },
            },
          ],
        },
      ],
    };

    const response = await fetch(`${baseUrl}/api/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "EVENT_RECEIVED");
    assert.equal(
      await InboundMessage.countDocuments({
        phoneNumber: { $regex: `^${FIXTURE_PHONE}` },
      }),
      0,
    );
  });

  it("ignores a text message without a wamid safely", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                contacts: [{ profile: { name: "T" }, wa_id: "91999988202" }],
                messages: [
                  {
                    from: "91999988202",
                    timestamp: "0",
                    type: "text",
                    text: { body: "Remind me to test tomorrow at 9am" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await fetch(`${baseUrl}/api/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "EVENT_RECEIVED");
    assert.equal(
      await InboundMessage.countDocuments({
        phoneNumber: "91999988202",
      }),
      0,
    );
    assert.equal(await Reminder.countDocuments({ task: FIXTURE_TASK }), 0);
  });
});

describe("InboundMessage schema", () => {
  it("has a unique wamid index and a TTL index on expiresAt", async () => {
    const indexes = await InboundMessage.collection.indexes();

    const wamidIndex = indexes.find((i) => i.key.wamid === 1);

    assert.ok(wamidIndex, "unique wamid index exists");
    assert.equal(wamidIndex.unique, true);

    const ttlIndex = indexes.find((i) => i.key.expiresAt === 1);

    assert.ok(ttlIndex, "expiresAt TTL index exists");
    assert.equal(ttlIndex.expireAfterSeconds, 0);
  });
});