import express from "express";
import { classifyMessage } from "../services/commandRouter.service.js";

const router = express.Router();

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
