import { formatUsPhoneStoredForUi } from "../phone/usPhoneNumber"

/** Shown in tables and read-only inputs when email is missing or privacy-redacted. */
export const EMAIL_UNAVAILABLE_LABEL = "Email unavailable"

/** API mask for a hidden co-sponsor email or phone. Stored values are unchanged. */
export const REDACTED_LABEL = "redacted"

/** Shown when a co-sponsor contact or investor phone is hidden. */
export const PHONE_UNAVAILABLE_LABEL = REDACTED_LABEL

const UNAVAILABLE_TOKENS = new Set([
  "",
  "—",
  "-",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "redacted",
  "not visible",
  "email unavailable",
  "unavailable",
])

function normalizeEmailToken(raw: string): string {
  return raw.trim().toLowerCase()
}

/** True when the value is a real address safe to show / use for mailto. */
export function isDisplayableEmail(
  email: string | null | undefined | unknown,
): boolean {
  const em = String(email ?? "").trim()
  if (!em) return false
  if (UNAVAILABLE_TOKENS.has(normalizeEmailToken(em))) return false
  if (/redacted/i.test(em)) return false
  return em.includes("@")
}

/**
 * Display label for email columns and read-only inputs.
 * Missing, placeholder, or redacted values → {@link EMAIL_UNAVAILABLE_LABEL}.
 */
export function displayEmail(email: string | null | undefined | unknown): string {
  const em = String(email ?? "").trim()
  if (normalizeEmailToken(em) === REDACTED_LABEL) return REDACTED_LABEL
  if (isDisplayableEmail(em)) return em
  return EMAIL_UNAVAILABLE_LABEL
}

/** True when the API replaced an email or phone with the redaction mask. */
export function isPrivacyRedacted(value: string | null | undefined | unknown): boolean {
  const token = String(value ?? "").trim().toLowerCase()
  return (
    token === REDACTED_LABEL ||
    token === "email unavailable" ||
    token === "phone unavailable"
  )
}

export function isRedactedPhone(phone: string | null | undefined | unknown): boolean {
  const token = String(phone ?? "").trim().toLowerCase()
  return (
    token === PHONE_UNAVAILABLE_LABEL.toLowerCase() ||
    token === "redacted" ||
    token.startsWith("redacted ")
  )
}

/** Formatted phone, or the word "redacted" when the API withheld the number. */
export function displayPhone(phone: string | null | undefined | unknown): string {
  if (isRedactedPhone(phone)) return REDACTED_LABEL
  return formatUsPhoneStoredForUi(phone)
}
