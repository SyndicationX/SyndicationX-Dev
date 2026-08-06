export const DEAL_STATUSES = [
  "draft_hidden",
  "coming_soon",
  "open_soft_commitment",
  "open_hard_commitment",
  "open_investment",
  "waitlist",
  "closed",
  "past",
] as const;

export type DealStatus = (typeof DEAL_STATUSES)[number];

export function isDealStatus(raw: string | null | undefined): raw is DealStatus {
  return DEAL_STATUSES.includes(raw as DealStatus);
}

export function normalizeDealStatus(
  raw: string | null | undefined,
): DealStatus | null {
  const v = String(raw ?? "").trim();
  return isDealStatus(v) ? v : null;
}
