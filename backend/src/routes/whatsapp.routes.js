import express from "express";
import { sendWhatsAppMessage } from "../services/whatsapp.service.js";

const router = express.Router();

// Legacy/test surface: an unauthenticated arbitrary-message send endpoint
// must not be publicly reachable. Default-disabled unless
// ENABLE_LEGACY_API=true. The real Meta webhook is unaffected (separate
// route file).
router.use((req, res, next) => {
  if (process.env.ENABLE_LEGACY_API !== "true") {
    return res.status(404).json({ message: "Not found" });
  }

  next();
});

router.post("/test", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    const result = await sendWhatsAppMessage(
      phoneNumber,
      "🚀 PingMe is now connected to WhatsApp!",
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
});

export default router;
