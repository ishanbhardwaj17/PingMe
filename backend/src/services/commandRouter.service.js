const INTENTS = {
  CREATE_REMINDER: "CREATE_REMINDER",
  LIST_REMINDERS: "LIST_REMINDERS",
  SHOW_DIGEST: "SHOW_DIGEST",
  DELETE_REMINDER: "DELETE_REMINDER",
  HELP: "HELP",
  UNKNOWN: "UNKNOWN",
};

export const HELP_TEXT =
  "PingMe commands:\n\n• Remind me to ... tomorrow at 8 PM\n• Show my reminders\n• Today's schedule\n• Cancel my reminders\n• Help";

export const UNKNOWN_TEXT =
  "I didn't understand that command.\n\nTry:\n• Remind me to ...\n• Show my reminders\n• Today's schedule\n• Cancel my reminders\n• Help";

/**
 * Deterministically classify an incoming WhatsApp message.
 *
 * Ordering is critical:
 * 1. CREATE_REMINDER first: any message that begins with "remind" is a
 *    reminder command, even when its task contains words like delete,
 *    remove, today, or schedule.
 * 2. DELETE_REMINDER before LIST_REMINDERS, because every bulk-cancel
 *    phrase ("cancel my reminders", "delete all my reminders") contains
 *    the LIST phrase "my reminders".
 * 3. LIST_REMINDERS, SHOW_DIGEST, HELP, then UNKNOWN as the fallback.
 *
 * Matching uses word boundaries so bare words ("delete", "remove",
 * "today") never trigger an intent on their own.
 */
export const classifyMessage = (text) => {
  const normalized = (text ?? "").toLowerCase().trim();

  if (!normalized) {
    return { intent: INTENTS.HELP };
  }

  if (/^remind\b/.test(normalized)) {
    return { intent: INTENTS.CREATE_REMINDER };
  }

  if (/\b(?:cancel|delete)\s+(?:all\s+)?my reminders\b/.test(normalized)) {
    return { intent: INTENTS.DELETE_REMINDER };
  }

  if (
    /\b(?:show|list)\s+(?:my\s+)?reminders\b/.test(normalized) ||
    /\bmy reminders\b/.test(normalized)
  ) {
    return { intent: INTENTS.LIST_REMINDERS };
  }

  if (
    /\btoday'?s schedule\b/.test(normalized) ||
    /\btoday\b/.test(normalized) ||
    /\bdigest\b/.test(normalized)
  ) {
    return { intent: INTENTS.SHOW_DIGEST };
  }

  if (
    normalized === "help" ||
    normalized === "commands" ||
    /\bwhat can you do\b/.test(normalized)
  ) {
    return { intent: INTENTS.HELP };
  }

  return { intent: INTENTS.UNKNOWN };
};

export { INTENTS };