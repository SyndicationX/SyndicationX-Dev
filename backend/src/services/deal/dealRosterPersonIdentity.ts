/**
 * Team Member / roster person identity.
 *
 * People are identified by stable IDs (`contact_id` / `user_id`) and, when
 * present, a usable email. First + last name is never an identity key: two
 * people can share a name and must stay separate.
 */

export type RosterResolvedPerson = {
  displayName: string;
  userDisplayName: string;
  userEmail: string;
  firstName: string;
  lastName: string;
};

export type RosterContactRecord = {
  id: string;
  email: string | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  fullName?: string | null | undefined;
};

export function normalizeRosterPersonId(
  raw: string | null | undefined,
): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function isUsableRosterPersonEmail(
  raw: string | null | undefined,
): boolean {
  const em = String(raw ?? "").trim();
  if (!em || !em.includes("@")) return false;
  if (/redacted/i.test(em)) return false;
  return true;
}

export function normalizeRosterPersonEmail(
  raw: string | null | undefined,
): string | null {
  if (!isUsableRosterPersonEmail(raw)) return null;
  return String(raw).trim().toLowerCase();
}

/**
 * Stable person bucket for a roster `contact_id` / `contact_member_id`.
 * Same email (from that ID's user or contact row, or an email-shaped ID)
 * collapses portal user id + CRM contact id into one person. Names are ignored.
 */
export function canonicalRosterPersonKey(
  rawId: string | null | undefined,
  emailById: ReadonlyMap<string, string>,
): string {
  const rk = normalizeRosterPersonId(rawId);
  if (!rk) return "";
  const fromId = emailById.get(rk);
  const fromLiteral = rk.includes("@") ? normalizeRosterPersonEmail(rk) : null;
  const em = fromId || fromLiteral;
  return em ? `em:${em}` : `id:${rk}`;
}

export function mapRawIdsToCanonicalPersonKeys(
  rawIds: readonly (string | null | undefined)[],
  emailById: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of rawIds) {
    const rk = normalizeRosterPersonId(raw);
    if (!rk) continue;
    out.set(rk, canonicalRosterPersonKey(rk, emailById));
  }
  return out;
}

/**
 * Overlay CRM contact fields onto a resolved roster person only when the
 * contact primary key matches the roster ID. Never match by first/last name.
 */
export function overlayResolvedPersonFromContactById(
  personId: string,
  existing: RosterResolvedPerson | undefined,
  contactById: ReadonlyMap<string, RosterContactRecord>,
): RosterResolvedPerson | undefined {
  const key = normalizeRosterPersonId(personId);
  const source = contactById.get(key);
  if (!source) return existing;

  const firstName = String(source.firstName ?? "").trim();
  const lastName = String(source.lastName ?? "").trim();
  const displayName =
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    existing?.displayName ||
    "—";
  const email = isUsableRosterPersonEmail(source.email)
    ? String(source.email).trim()
    : isUsableRosterPersonEmail(existing?.userEmail)
      ? String(existing?.userEmail).trim()
      : String(source.email ?? "").trim() || "—";
  return {
    displayName,
    userDisplayName: existing?.userDisplayName ?? "—",
    userEmail: email,
    firstName: firstName || existing?.firstName || "",
    lastName: lastName || existing?.lastName || "",
  };
}

export function applyContactOverlaysById(
  personIds: readonly string[],
  resolvedById: Map<string, RosterResolvedPerson>,
  contactById: ReadonlyMap<string, RosterContactRecord>,
): Map<string, RosterResolvedPerson> {
  for (const id of personIds) {
    const key = normalizeRosterPersonId(id);
    if (!key) continue;
    const next = overlayResolvedPersonFromContactById(
      key,
      resolvedById.get(key),
      contactById,
    );
    if (next) resolvedById.set(key, next);
  }
  return resolvedById;
}

/**
 * Secondary Team Member sources (`deal_investment` / LP roster) are skipped
 * when the same canonical person is already represented by `deal_member`.
 */
export function shouldAddSecondaryTeamMemberSource(params: {
  canonicalKey: string;
  coveredCanonical: ReadonlySet<string>;
}): boolean {
  const key = String(params.canonicalKey ?? "").trim();
  if (!key || key === "id:__empty__") return false;
  return !params.coveredCanonical.has(key);
}
