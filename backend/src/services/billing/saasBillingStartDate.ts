/**
 * CHANGE THE DEFAULT PLATFORM SAAS BILLING START DATE HERE.
 *
 * Midnight UTC on this calendar day is the first due date unless a platform
 * admin sets a per-deal date on add_deal_form.saas_billing_starts_at.
 * After a deal is on a Stripe subscription, next billing dates come from
 * Stripe — this value is not reused as the renewal date.
 *
 * Edit year / month / day below (month is 1–12, not 0-based).
 */
export const HARDCODED_SAAS_BILLING_START_YEAR = 2026;
export const HARDCODED_SAAS_BILLING_START_MONTH = 10; // October
export const HARDCODED_SAAS_BILLING_START_DAY = 1;

export const HARDCODED_SAAS_BILLING_STARTS_AT = new Date(
  Date.UTC(
    HARDCODED_SAAS_BILLING_START_YEAR,
    HARDCODED_SAAS_BILLING_START_MONTH - 1,
    HARDCODED_SAAS_BILLING_START_DAY,
    0,
    0,
    0,
    0,
  ),
);

const UTC_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** True once the complimentary platform window has ended (strictly after start instant). */
export function platformSaasBillingHasStarted(nowMs = Date.now()): boolean {
  return HARDCODED_SAAS_BILLING_STARTS_AT.getTime() < nowMs;
}

export function formatPlatformSaasBillingStartDisplay(): string {
  return `${UTC_MONTH_NAMES[HARDCODED_SAAS_BILLING_START_MONTH - 1]} ${HARDCODED_SAAS_BILLING_START_DAY}, ${HARDCODED_SAAS_BILLING_START_YEAR}`;
}

export function platformSaasBillingNotYetDueMessage(): string {
  return `The platform is complimentary until ${formatPlatformSaasBillingStartDisplay()}. Payment is not required yet.`;
}

type DealSaasStartRow = {
  saasBillingStartsAt?: Date | string | null;
} | null;

/** Parse YYYY-MM-DD (or ISO starting with that) as midnight UTC. */
/** Midnight UTC for the current UTC calendar day. */
export function utcMidnightToday(nowMs = Date.now()): Date {
  const now = new Date(nowMs);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

export function utcMidnightFromYmdString(raw: string): Date | null {
  const s = String(raw ?? "").trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!ymd) return null;
  const y = Number(ymd[1]);
  const mo = Number(ymd[2]);
  const d = Number(ymd[3]);
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

export function formatSaasBillingStartDisplay(startsAt: Date): string {
  return `${UTC_MONTH_NAMES[startsAt.getUTCMonth()]} ${startsAt.getUTCDate()}, ${startsAt.getUTCFullYear()}`;
}

/** Per-deal first due date, falling back to the platform default. */
export function dealSaasBillingStartsAt(row?: DealSaasStartRow): Date {
  const raw = row?.saasBillingStartsAt;
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const fromYmd = utcMidnightFromYmdString(raw);
    if (fromYmd) return fromYmd;
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t);
  }
  return HARDCODED_SAAS_BILLING_STARTS_AT;
}

export function dealSaasBillingHasStarted(
  row?: DealSaasStartRow,
  nowMs = Date.now(),
): boolean {
  return dealSaasBillingStartsAt(row).getTime() < nowMs;
}

export function dealSaasBillingNotYetDueMessage(row?: DealSaasStartRow): string {
  return `This deal is complimentary until ${formatSaasBillingStartDisplay(dealSaasBillingStartsAt(row))}. Payment is not required yet.`;
}
