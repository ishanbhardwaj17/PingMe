const INTENTS = {
  CREATE_REMINDER: "CREATE_REMINDER",
  LIST_REMINDERS: "LIST_REMINDERS",
  SHOW_DIGEST: "SHOW_DIGEST",
  DELETE_REMINDER: "DELETE_REMINDER",
  EDIT_REMINDER: "EDIT_REMINDER",
  SNOOZE_REMINDER: "SNOOZE_REMINDER",
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

  if (parseNumberedEdit(normalized)) {
    return { intent: INTENTS.EDIT_REMINDER };
  }

  if (parseNumberedSnooze(normalized)) {
    return { intent: INTENTS.SNOOZE_REMINDER };
  }

  if (parseNumberedDelete(normalized)) {
    return { intent: INTENTS.DELETE_REMINDER };
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

const NUMBERED_DELETE_RE = /^(?:delete|cancel)\s+reminder\s+(\d+)\b/;
const NUMBERED_EDIT_RE = /^edit\s+reminder\s+(\d+)\b/;
const NUMBERED_SNOOZE_RE = /^snooze\s+reminder\s+(\d+)\b/;

/**
 * Extract the number from "delete reminder N" / "cancel reminder N".
 * @returns {{ number: number } | null}
 */
export const parseNumberedDelete = (text) => {
  const match = NUMBERED_DELETE_RE.exec((text ?? "").toLowerCase().trim());

  return match ? { number: Number(match[1]) } : null;
};

/**
 * Extract the number and the replacement reminder text from
 * "edit reminder N <new reminder text>".
 * @returns {{ number: number, remainder: string } | null}
 */
export const parseNumberedEdit = (text) => {
  const match = NUMBERED_EDIT_RE.exec((text ?? "").toLowerCase().trim());

  if (!match) {
    return null;
  }

  const remainder = (text ?? "").trim().slice(match[0].length).trim();

  if (!remainder) {
    return null;
  }

  return { number: Number(match[1]), remainder };
};

/**
 * Extract the number and the snooze target from
 * "snooze reminder N <for/in/until target>".
 * @returns {{ number: number, remainder: string } | null}
 */
export const parseNumberedSnooze = (text) => {
  const match = NUMBERED_SNOOZE_RE.exec((text ?? "").toLowerCase().trim());

  if (!match) {
    return null;
  }

  const remainder = (text ?? "").trim().slice(match[0].length).trim();

  if (!remainder) {
    return null;
  }

  return { number: Number(match[1]), remainder };
};

export { INTENTS };