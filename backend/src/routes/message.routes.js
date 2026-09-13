import express from "express";
import { classifyMessage } from "../services/commandRouter.service.js";

const router = express.Router();

// Legacy/test surface: not required by the WhatsApp product flow.
// Default-disabled unless ENABLE_LEGACY_API=true.
router.use((req, res, next) => {
  if (process.env.ENABLE_LEGACY_API !== "true") {
    return res.status(404).json({ message: "Not found" });
  }

  next();
});

router.post("/", (req, res) => {
  try {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
      return res.status(400).json({
        message: "phoneNumber and message are required",
      });
    }

    const classification = classifyMessage(message);

    return res.json(classification);
  } catch (error) {
    return res.status(500).json({
      message: error.message,
    });
  }
});

export default router;
