import express from "express";
import { sendWhatsAppMessage } from "../services/whatsapp.service.js";

const router = express.Router();

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
