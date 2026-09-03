import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import app, { getHealthStatus } from "../src/app.js";
import redisConnection from "../src/config/redis.js";

describe("getHealthStatus", () => {
  it("reports ok when MongoDB and Redis are available", async () => {
    const status = await getHealthStatus({
      mongooseConn: { readyState: 1 },
      redisConn: { ping: async () => "PONG" },
    });

    assert.deepEqual(status, {
      status: "ok",
      api: "up",
      mongodb: "up",
      redis: "up",
    });
  });

  it("reports degraded when dependencies are unavailable", async () => {
    const status = await getHealthStatus({
      mongooseConn: { readyState: 0 },
      redisConn: {
        ping: async () => {
          throw new Error("connection refused");
        },
      },
    });

    assert.equal(status.status, "degraded");
    assert.equal(status.mongodb, "down");
    assert.equal(status.redis, "down");
  });
});

describe("GET /health", () => {
  let server;
  let baseUrl;

  before(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    server = app.listen(0);

    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await redisConnection.quit().catch(() => {});
    await mongoose.disconnect();
  });

  it("returns 200 with healthy dependency status", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.status, "ok");
    assert.equal(body.api, "up");
    assert.equal(body.mongodb, "up");
    assert.equal(body.redis, "up");
  });

  it("exposes no secrets in the response", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    const serialized = JSON.stringify(body);

    assert.equal(serialized.includes(process.env.WHATSAPP_TOKEN), false);
    assert.equal(serialized.includes(process.env.MONGO_URI), false);
    assert.equal(
      serialized.includes(process.env.WHATSAPP_PHONE_NUMBER_ID),
      false,
    );
  });
});