const FORMATTING_ONLY = /^[0-9+\-() ]+$/;

/**
 * Normalize a phone number to its canonical digits-only representation.
 *
 * Only legitimate formatting characters (+, -, parentheses, spaces) are
 * removed. Input containing any other character (letters, slashes, etc.)
 * is rejected rather than silently stripped, and no country code is ever
 * invented. Example: "+91 8824 895152" -> "918824895152".
 */
export const normalizePhoneNumber = (phoneNumber) => {
  if (typeof phoneNumber !== "string" || phoneNumber.trim() === "") {
    throw new Error("Phone number is required");
  }

  if (!FORMATTING_ONLY.test(phoneNumber)) {
    throw new Error("Invalid phone number");
  }

  const canonical = phoneNumber.replace(/\D/g, "");

  if (!canonical) {
    throw new Error("Phone number is required");
  }

  return canonical;
};