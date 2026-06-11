import { sendWhatsAppMessage } from "./whatsapp.service.js";

export const sendReminder = async (reminder) => {
  await sendWhatsAppMessage(
    reminder.phoneNumber,
    `⏰ Reminder\n\n${reminder.task}`
  );
};