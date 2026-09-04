import { handleIncomingMessage } from "../services/incoming-message.service.js";
import { normalizePhoneNumber } from "../utils/phone.js";

export const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    } else {
      console.warn("Webhook verification failed: invalid token");
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
};

export const receiveMessage = async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (message && message.text?.body) {
      const phoneNumber = normalizePhoneNumber(message.from);
      const text = message.text.body;

      console.log(`Received message from ${phoneNumber}: "${text}"`);

      // Handle message asynchronously so we can reply with 200 OK immediately (prevent Meta timeouts)
      handleIncomingMessage(phoneNumber, text).catch((err) => {
        console.error("Error processing incoming message async:", err.message);
      });
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Error in receiveMessage webhook:", error);
    res.sendStatus(500);
  }
};
