export const detectRecurrence = (text) => {
  const lower = text.toLowerCase();

  if (lower.includes("every day")) {
    return "daily";
  }

  if (lower.includes("every week")) {
    return "weekly";
  }

  if (lower.includes("every month")) {
    return "monthly";
  }

  return null;
};