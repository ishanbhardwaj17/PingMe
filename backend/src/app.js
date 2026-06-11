import express from "express";
import cors from "cors";
import reminderRoutes from "./routes/reminder.routes.js";
import messageRoutes from "./routes/message.routes.js";
import whatsappRoutes from "./routes/whatsapp.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/reminders", reminderRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/whatsapp", whatsappRoutes);

app.get("/", (req, res) => {
  res.send("PingMe API Running 🚀");
});

export default app;
