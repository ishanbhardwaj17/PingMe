import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import reminderRoutes from "./routes/reminder.routes.js";
import messageRoutes from "./routes/message.routes.js";
import whatsappRoutes from "./routes/whatsapp.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import redisConnection from "./config/redis.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/reminders", reminderRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/webhook", webhookRoutes);

export const getHealthStatus = async ({
  mongooseConn = mongoose.connection,
  redisConn = redisConnection,
} = {}) => {
  const mongodb = mongooseConn.readyState === 1;

  let redis = false;

  try {
    await redisConn.ping();
    redis = true;
  } catch {
    redis = false;
  }

  return {
    status: mongodb && redis ? "ok" : "degraded",
    api: "up",
    mongodb: mongodb ? "up" : "down",
    redis: redis ? "up" : "down",
  };
};

app.get("/health", async (req, res) => {
  const health = await getHealthStatus();

  res.status(health.status === "ok" ? 200 : 503).json(health);
});

app.get("/", (req, res) => {
  res.send("PingMe API Running 🚀");
});

export default app;
