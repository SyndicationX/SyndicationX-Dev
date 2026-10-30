const SENSITIVE_KEY =
  /(routing|accountnumber|account_number|achaccount|fullaccount|ssn|taxid|tax_id)/i;

/** Keep a Stripe Connect id. Mask routing and deposit account numbers. */
export function redactBankAccountAuditChanges(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBankAccountAuditChanges);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = maskKeepLast4(child);
    } else {
      out[key] = redactBankAccountAuditChanges(child);
    }
  }
  return out;
}

export function maskKeepLast4(value: unknown): string {
  const raw = String(value ?? "").replace(/\s+/g, "");
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const source = digits || raw;
  const last4 = source.slice(-4);
  return `••••${last4}`;
}
