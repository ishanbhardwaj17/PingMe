const INTENTS = {
  CREATE_REMINDER: "CREATE_REMINDER",
  LIST_REMINDERS: "LIST_REMINDERS",
  SHOW_DIGEST: "SHOW_DIGEST",
  DELETE_REMINDER: "DELETE_REMINDER",
  HELP: "HELP",
};

export const classifyMessage = (text) => {
  const normalizedText = (text || "").toLowerCase().trim();

  if (!normalizedText) {
    return {
      intent: INTENTS.HELP,
    };
  }

  if (
    normalizedText.includes("show my reminders") ||
    normalizedText.includes("list reminders") ||
    normalizedText.includes("my reminders")
  ) {
    return {
      intent: INTENTS.LIST_REMINDERS,
    };
  }

  if (
    normalizedText.includes("delete") ||
    normalizedText.includes("remove") ||
    normalizedText.includes("cancel reminder")
  ) {
    return {
      intent: INTENTS.DELETE_REMINDER,
    };
  }

  if (
    normalizedText.includes("today") ||
    normalizedText.includes("schedule") ||
    normalizedText.includes("digest")
  ) {
    return {
      intent: INTENTS.SHOW_DIGEST,
    };
  }

  if (
    normalizedText === "help" ||
    normalizedText.includes("what can you do") ||
    normalizedText.includes("commands")
  ) {
    return {
      intent: INTENTS.HELP,
    };
  }

  return {
    intent: INTENTS.CREATE_REMINDER,
  };
};

export { INTENTS };
