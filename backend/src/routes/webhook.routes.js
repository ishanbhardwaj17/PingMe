import express from "express";
import { verifyWebhook, receiveMessage } from "../controllers/webhook.controller.js";

const router = express.Router();

router.get("/", verifyWebhook);
router.post("/", receiveMessage);

export default router;
