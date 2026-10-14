import { and, desc, eq, ne, or, sql, type AnyColumn } from "drizzle-orm";
import { db } from "../../database/db.js";
import { addDealForm } from "../../schema/deal.schema/add-deal-form.schema.js";
import {
  dealMember,
  type DealMemberRow,
} from "../../schema/deal.schema/deal-member.schema.js";
import { dealMemberRemovalLogs } from "../../schema/deal.schema/deal-member-removal-log.schema.js";
import {
  dealInvestment,
  type DealInvestmentRow,
} from "../../schema/deal.schema/deal-investment.schema.js";
import {
  dealLpInvestor,
  type DealLpInvestorRow,
} from "../../schema/deal.schema/deal-lp-investor.schema.js";
import { users } from "../../schema/auth.schema/signin.js";
import { contact } from "../../schema/contact.schema.js";
import { invalidateContactDirectoryCache } from "../cache/listReadCache.js";
import { assertEligibleForNewDealRosterAdd } from "../user/portalUserRosterGuard.service.js";
import {
  applyTotalCommittedToDealInvestmentRowForCanonical,
  enrichInvestorRolesForDealRows,
  formatCommittedUsdWhole,
  GENERAL_PARTNER_ROLE_STORED,
  isGeneralPartnerStoredRole,
  groupDealInvestmentsByCanonicalKey,
  listDealInvestmentsByDealId,
  mapContactIdsToCanonicalCommitmentKeys,
  loadInvitationMailSentFlags,
  mapRowToInvestorApi,
  resolveUserDisplayNamesByIds,
  resolveUserInvestorProfileNamesByIds,
  resolveUsersByContactIds,
  rowIsGeneralPartnerForRoster,
  sumCommittedFromInvestorsAddedByMemberContacts,
  totalCommittedByCanonicalKeyFromRows,
  DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER,
} from "./dealInvestment.service.js";
import { listInvestorClassesByDealId } from "./dealInvestorClass.service.js";
import { shouldAddSecondaryTeamMemberSource } from "./dealRosterPersonIdentity.js";

export type UpsertDealMemberInput = {
  contactMemberId: string;
  dealMemberRole: string;
  sendInvitationMail: string;
  /** Set on insert only; not overwritten on conflict update. */
  addedByUserId: string;
  /**
   * Autosave from the add modal. A draft write never demotes an existing saved
   * member; an explicit Save always clears the flag.
   */
  isDraft?: boolean;
};

/** Stored `deal_member.deal_member_role` for the single Lead Sponsor slot per deal. */
export const LEAD_SPONSOR_DEAL_MEMBER_ROLE = "Lead Sponsor";

/** Shown when a delete would leave the deal with no Lead Sponsor. */
export const LEAD_SPONSOR_REQUIRED_MESSAGE =
  "At least one lead sponsor should be present in the deal";

function normalizeContactKey(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

function sendInvitationYesFromInput(raw: string | null | undefined): "yes" | "no" {
  return String(raw ?? "").toLowerCase() === "yes" ? "yes" : "no";
}

/**
 * On upsert, keep `send_invitation_mail = yes` when the client sends `no` (edit/autosave
 * default) so a prior successful invite is not cleared.
 */
export function sqlPreserveSendInvitationMailOnUpsert(
  incoming: string | null | undefined,
  existingColumn: AnyColumn,
) {
  const send = sendInvitationYesFromInput(incoming);
  return sql<string>`CASE WHEN ${send} = 'yes' THEN 'yes' WHEN lower(trim(coalesce(${existingColumn}, ''))) = 'yes' THEN 'yes' ELSE 'no' END`;
}

async function resolveInvitationMailContactKeys(input: {
  contactMemberId?: string;
  toEmail?: string;
}): Promise<string[]> {
  const contactKeys = new Set<string>();
  const cid = String(input.contactMemberId ?? "").trim();
  if (cid) contactKeys.add(normalizeContactKey(cid));

  const toEmail = String(input.toEmail ?? "").trim().toLowerCase();
  if (toEmail.includes("@")) {
    contactKeys.add(normalizeContactKey(toEmail));

    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(trim(${users.email})) = ${toEmail}`)
      .limit(1);
    if (u?.id) contactKeys.add(normalizeContactKey(String(u.id)));

    const [c] = await db
      .select({ id: contact.id })
      .from(contact)
      .where(sql`lower(trim(${contact.email})) = ${toEmail}`)
      .limit(1);
    if (c?.id) contactKeys.add(normalizeContactKey(String(c.id)));
  }

  return [...contactKeys].filter(Boolean);
}

/**
 * Sets `send_invitation_mail = yes` on matching `deal_member` and `deal_lp_investor` rows
 * after a successful invite.
 */
export async function markDealMemberInvitationMailSent(
  dealId: string,
  input: { contactMemberId?: string; toEmail?: string },
): Promise<void> {
  const did = dealId.trim();
  if (!did) return;

  const keys = await resolveInvitationMailContactKeys(input);
  if (keys.length === 0) return;

  const now = new Date();
  const memberContactMatch = or(
    ...keys.map(
      (k) => sql`lower(trim(${dealMember.contactMemberId})) = ${k}`,
    ),
  );
  if (memberContactMatch) {
    await db
      .update(dealMember)
      .set({ sendInvitationMail: "yes", updatedAt: now })
      .where(and(eq(dealMember.dealId, did), memberContactMatch));
  }

  const lpContactMatch = or(
    ...keys.map(
      (k) => sql`lower(trim(${dealLpInvestor.contactMemberId})) = ${k}`,
    ),
  );
  if (lpContactMatch) {
    await db
      .update(dealLpInvestor)
      .set({ sendInvitationMail: "yes", updatedAt: now })
      .where(and(eq(dealLpInvestor.dealId, did), lpContactMatch));
  }
}

/** Higher wins when the same person was saved on the roster more than once. */
function dealMemberRoleRank(role: string): number {
  const s = role.trim().toLowerCase();
  if (s === "lead sponsor") return 50;
  if (s === "admin sponsor") return 40;
  if (s === "co-sponsor" || s === "co sponsor") return 30;
  if (s === "deal member") return 20;
  if (isGeneralPartnerStoredRole(role)) return 10;
  return 0;
}

/**
 * One roster row per person. Portal user id and CRM contact id for the same
 * email are the same person; keep the stronger role (Lead, then Admin sponsor).
 */
function collapseDealMembersByCanonicalPerson(
  members: DealMemberRow[],
  rawToCanonical: Map<string, string>,
): DealMemberRow[] {
  const best = new Map<string, DealMemberRow>();
  const passthrough: DealMemberRow[] = [];
  for (const m of members) {
    const k = normalizeContactKey(m.contactMemberId);
    const canonicalKey = k ? (rawToCanonical.get(k) ?? `id:${k}`) : "";
    if (!canonicalKey || canonicalKey === "id:__empty__") {
      passthrough.push(m);
      continue;
    }
    const prev = best.get(canonicalKey);
    if (!prev) {
      best.set(canonicalKey, m);
      continue;
    }
    const nextRank = dealMemberRoleRank(m.dealMemberRole ?? "");
    const prevRank = dealMemberRoleRank(prev.dealMemberRole ?? "");
    if (
      nextRank > prevRank ||
      (nextRank === prevRank && m.createdAt > prev.createdAt)
    ) {
      best.set(canonicalKey, m);
    }
  }
  return [...passthrough, ...best.values()];
}

/** Canonical row for labels / ids when a contact has multiple investments (newest wins). */
function pickLatestInvestmentForDealMember(
  arr: DealInvestmentRow[],
): DealInvestmentRow | undefined {
  if (arr.length === 0) return undefined;
  return [...arr].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
}

function syntheticInvestmentFromDealMember(m: DealMemberRow): DealInvestmentRow {
  return {
    id: m.id,
    dealId: m.dealId,
    offeringId: "",
    contactId: m.contactMemberId,
    contactDisplayName: "",
    profileId: "",
    userInvestorProfileId: null,
    investor_role: m.dealMemberRole,
    isDraft: m.isDraft,
    fundApproved: false,
    fundApprovedBy: null,
    fundApprovedAt: null,
    fundApprovedCommitmentSnapshot: "",
    status: "",
    investorClass: "",
    docSignedDate: null,
    esignStatusJson: null,
    investorQuestionnaireAnswersJson: null,
    investorW9FormJson: null,
    fundingMethod: "",
    commitmentAmount: "",
    commitmentCompletedAt: null,
    commitmentInvestorEmailSentAt: null,
    commitmentSponsorEmailSentAt: null,
    extraContributionAmounts: [],
    documentStoragePath: null,
    createdAt: m.createdAt,
  };
}

/** GP-class people who were stored on the LP roster still belong on General Partners. */
function syntheticInvestmentFromGpLpRoster(
  m: DealLpInvestorRow,
): DealInvestmentRow {
  return {
    id: m.id,
    dealId: m.dealId,
    offeringId: "",
    contactId: m.contactMemberId,
    contactDisplayName: String(m.investorName ?? "").trim(),
    profileId: m.profileId?.trim() ?? "",
    userInvestorProfileId: m.userInvestorProfileId ?? null,
    investor_role: GENERAL_PARTNER_ROLE_STORED,
    isDraft: m.isDraft,
    fundApproved: false,
    fundApprovedBy: null,
    fundApprovedAt: null,
    fundApprovedCommitmentSnapshot: "",
    status: "",
    investorClass: m.investorClass,
    docSignedDate: m.docSignedDate?.trim() ?? null,
    esignStatusJson: m.esignStatusJson?.trim() ?? null,
    investorQuestionnaireAnswersJson: null,
    investorW9FormJson: null,
    fundingMethod: "",
    commitmentAmount: m.committed_amount,
    commitmentCompletedAt: null,
    commitmentInvestorEmailSentAt: null,
    commitmentSponsorEmailSentAt: null,
    extraContributionAmounts: [],
    documentStoragePath: null,
    createdAt: m.createdAt,
  };
}

type MemberListRowMeta = {
  addedBy: string | null;
  contactMemberId: string;
  investorKind?: "lp_roster" | "member_roster";
};

/**
 * Upserts `(deal_id, contact_member_id)` when an investment is saved.
 * `added_by` is set on first insert only.
 */
export async function upsertDealMemberForDeal(
  dealId: string,
  input: UpsertDealMemberInput,
): Promise<void> {
  const cid = input.contactMemberId.trim();
  if (!cid) return;

  const [existing] = await db
    .select({ contactMemberId: dealMember.contactMemberId })
    .from(dealMember)
    .where(
      and(eq(dealMember.dealId, dealId), eq(dealMember.contactMemberId, cid)),
    )
    .limit(1);
  if (!existing) {
    await assertEligibleForNewDealRosterAdd(cid, input.addedByUserId);
  }

  const send = sendInvitationYesFromInput(input.sendInvitationMail);
  const now = new Date();
  const role = input.dealMemberRole?.trim() ?? "";
  const isDraft = input.isDraft === true;

  await db
    .insert(dealMember)
    .values({
      dealId,
      addedBy: input.addedByUserId,
      contactMemberId: cid,
      dealMemberRole: role,
      sendInvitationMail: send,
      isDraft,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [dealMember.dealId, dealMember.contactMemberId],
      set: {
        addedBy: sql`COALESCE(${dealMember.addedBy}, ${input.addedByUserId}::uuid)`,
        dealMemberRole: role,
        sendInvitationMail: sqlPreserveSendInvitationMailOnUpsert(
          input.sendInvitationMail,
          dealMember.sendInvitationMail,
        ),
        ...(isDraft ? {} : { isDraft: false }),
        updatedAt: now,
      },
    });
}

export class DealLeadSponsorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DealLeadSponsorValidationError";
  }
}

function normalizeRoleLabel(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function roleIsLeadSponsor(raw: string | null | undefined): boolean {
  return normalizeRoleLabel(raw) === "lead sponsor";
}

function roleIsSponsor(raw: string | null | undefined): boolean {
  const role = normalizeRoleLabel(raw);
  return (
    role === "lead sponsor" ||
    role === "admin sponsor" ||
    role === "co-sponsor" ||
    role === "co sponsor"
  );
}

function normalizeRosterContactId(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

const ROSTER_CONTACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same placeholders as deal-name uniqueness on create/edit. */
const DEAL_NAME_UNIQUENESS_EXEMPT = new Set(["untitled deal", "pending"]);

type DealWriteTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Organization for a roster id: the portal user's company, or the CRM contact's
 * company when that contact is not a portal user.
 */
async function resolveOrganizationIdForRosterContact(
  contactMemberId: string,
): Promise<string | null> {
  const id = contactMemberId.trim();
  if (!ROSTER_CONTACT_UUID_RE.test(id)) return null;

  const [userRow] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (userRow) {
    const org = String(userRow.organizationId ?? "").trim();
    return org || null;
  }

  const [contactRow] = await db
    .select({
      organizationId: contact.organizationId,
      email: contact.email,
    })
    .from(contact)
    .where(eq(contact.id, id))
    .limit(1);
  if (!contactRow) return null;

  const email = String(contactRow.email ?? "").trim().toLowerCase();
  if (email.includes("@")) {
    const [matchedUser] = await db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(sql`lower(trim(${users.email})) = ${email}`)
      .limit(1);
    const userOrg = String(matchedUser?.organizationId ?? "").trim();
    if (userOrg) return userOrg;
  }

  const contactOrg = String(contactRow.organizationId ?? "").trim();
  return contactOrg || null;
}

type DealRosterPerson = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** Portal company, or the CRM contact's company when they are not a portal user. */
  homeOrganizationId: string;
  isPortalUser: boolean;
};

function sameOrganization(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function contactNameOrDash(raw: string): string {
  const name = String(raw ?? "").trim();
  return name || "—";
}

/**
 * Identity behind a deal roster id (portal user id or CRM contact id).
 */
async function resolveDealRosterPerson(
  tx: DealWriteTx,
  rosterId: string,
): Promise<DealRosterPerson | null> {
  const id = rosterId.trim();
  if (!ROSTER_CONTACT_UUID_RE.test(id)) return null;

  const [userRow] = await tx
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      organizationId: users.organizationId,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (userRow) {
    const email = String(userRow.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) return null;
    return {
      email,
      firstName: String(userRow.firstName ?? "").trim(),
      lastName: String(userRow.lastName ?? "").trim(),
      phone: String(userRow.phone ?? "").trim(),
      homeOrganizationId: String(userRow.organizationId ?? "").trim(),
      isPortalUser: true,
    };
  }

  const [contactRow] = await tx
    .select({
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phone,
      organizationId: contact.organizationId,
    })
    .from(contact)
    .where(eq(contact.id, id))
    .limit(1);
  if (!contactRow) return null;

  const email = String(contactRow.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return null;

  const [matchedUser] = await tx
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      organizationId: users.organizationId,
    })
    .from(users)
    .where(sql`lower(trim(${users.email})) = ${email}`)
    .limit(1);
  if (matchedUser) {
    return {
      email,
      firstName:
        String(contactRow.firstName ?? "").trim() ||
        String(matchedUser.firstName ?? "").trim(),
      lastName:
        String(contactRow.lastName ?? "").trim() ||
        String(matchedUser.lastName ?? "").trim(),
      phone:
        String(contactRow.phone ?? "").trim() ||
        String(matchedUser.phone ?? "").trim(),
      homeOrganizationId: String(matchedUser.organizationId ?? "").trim(),
      isPortalUser: true,
    };
  }

  return {
    email,
    firstName: String(contactRow.firstName ?? "").trim(),
    lastName: String(contactRow.lastName ?? "").trim(),
    phone: String(contactRow.phone ?? "").trim(),
    homeOrganizationId: String(contactRow.organizationId ?? "").trim(),
    isPortalUser: false,
  };
}

async function listSavedDealRosterIds(
  tx: DealWriteTx,
  dealId: string,
): Promise<string[]> {
  const members = await tx
    .select({ id: dealMember.contactMemberId })
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.isDraft, false)));
  const lpInvestors = await tx
    .select({ id: dealLpInvestor.contactMemberId })
    .from(dealLpInvestor)
    .where(
      and(eq(dealLpInvestor.dealId, dealId), eq(dealLpInvestor.isDraft, false)),
    );
  const investments = await tx
    .select({ id: dealInvestment.contactId })
    .from(dealInvestment)
    .where(
      and(eq(dealInvestment.dealId, dealId), eq(dealInvestment.isDraft, false)),
    );

  const ids = new Set<string>();
  for (const row of [...members, ...lpInvestors, ...investments]) {
    const id = String(row.id ?? "").trim();
    if (ROSTER_CONTACT_UUID_RE.test(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * A user in the destination company who can own the new CRM rows.
 * Prefer the lead sponsor when they belong to that company.
 */
async function resolveContactCreatorInOrganization(
  tx: DealWriteTx,
  organizationId: string,
  leadSponsorContactId: string,
): Promise<string | null> {
  const leadId = leadSponsorContactId.trim();
  if (ROSTER_CONTACT_UUID_RE.test(leadId)) {
    const [leadUser] = await tx
      .select({ id: users.id, organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, leadId))
      .limit(1);
    if (
      leadUser &&
      sameOrganization(String(leadUser.organizationId ?? ""), organizationId)
    ) {
      return leadUser.id;
    }

    const [leadContact] = await tx
      .select({ email: contact.email })
      .from(contact)
      .where(eq(contact.id, leadId))
      .limit(1);
    const leadEmail = String(leadContact?.email ?? "").trim().toLowerCase();
    if (leadEmail.includes("@")) {
      const [matched] = await tx
        .select({ id: users.id, organizationId: users.organizationId })
        .from(users)
        .where(sql`lower(trim(${users.email})) = ${leadEmail}`)
        .limit(1);
      if (
        matched &&
        sameOrganization(String(matched.organizationId ?? ""), organizationId)
      ) {
        return matched.id;
      }
    }
  }

  const [admin] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        sql`lower(trim(${users.role})) = 'company_admin'`,
      ),
    )
    .limit(1);
  if (admin) return admin.id;

  const [member] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.organizationId, organizationId))
    .limit(1);
  return member?.id ?? null;
}

/**
 * People already on the deal who belong to a different company are copied into
 * the lead sponsor's company contacts. Their original contact row stays put.
 */
async function copyOutsideDealRosterIntoOrganization(
  tx: DealWriteTx,
  dealId: string,
  organizationId: string,
  leadSponsorContactId: string,
): Promise<Array<{ dealName: string; email: string }>> {
  const createdBy = await resolveContactCreatorInOrganization(
    tx,
    organizationId,
    leadSponsorContactId,
  );
  if (!createdBy) return [];

  const [deal] = await tx
    .select({ dealName: addDealForm.dealName })
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  const dealName = String(deal?.dealName ?? "").trim() || dealId;

  const rosterIds = await listSavedDealRosterIds(tx, dealId);
  const copiedEmails = new Set<string>();
  const created: Array<{ dealName: string; email: string }> = [];

  for (const rosterId of rosterIds) {
    const person = await resolveDealRosterPerson(tx, rosterId);
    if (!person) continue;
    if (sameOrganization(person.homeOrganizationId, organizationId)) continue;
    if (copiedEmails.has(person.email)) continue;

    const [existing] = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(
        and(
          eq(contact.organizationId, organizationId),
          sql`lower(trim(${contact.email})) = ${person.email}`,
        ),
      )
      .limit(1);
    if (existing) {
      copiedEmails.add(person.email);
      continue;
    }

    const firstName = contactNameOrDash(person.firstName);
    const lastName = contactNameOrDash(person.lastName);
    await tx.insert(contact).values({
      firstName,
      lastName,
      fullName: [firstName, lastName].filter((part) => part !== "—").join(" "),
      email: person.email,
      phone: person.phone,
      note: "",
      tags: [],
      lists: [],
      owners: [],
      status: "active",
      createdBy,
      organizationId,
      isPortalUser: person.isPortalUser,
      platformAdminOnly: false,
      visibleToUsers: false,
      relationship506b: "NO",
      referredByDealId: dealId,
      importSource: "deal_org_move",
    });
    copiedEmails.add(person.email);
    created.push({ dealName, email: person.email });
  }
  return created;
}

/**
 * Companies that should list this outside sponsor: the deal's company and the
 * company of the user who added them. A peer sponsor's company does not
 * receive the other sponsors.
 */
async function listOrganizationsForOutsideSponsorContact(
  tx: DealWriteTx,
  dealId: string,
  sponsorHomeOrganizationId: string,
  addedByUserId: string,
): Promise<string[]> {
  const targets = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const id = String(raw ?? "").trim();
    if (!ROSTER_CONTACT_UUID_RE.test(id)) return;
    if (sameOrganization(id, sponsorHomeOrganizationId)) return;
    targets.add(id);
  };

  const [deal] = await tx
    .select({ organizationId: addDealForm.organizationId })
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  add(deal?.organizationId);

  const adderId = addedByUserId.trim();
  if (ROSTER_CONTACT_UUID_RE.test(adderId)) {
    const [adder] = await tx
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, adderId))
      .limit(1);
    add(adder?.organizationId);
  }

  return [...targets];
}

/**
 * A copied sponsor or moved roster row stays in this company only when that
 * person is on a deal this company owns, or a user in this company added them
 * to a deal. Sharing a deal with a sponsor from this company is not enough.
 */
function copiedContactBelongsInOrganizationSql(orgId: string) {
  const emailMatchesRoster = sql`lower(trim(${contact.email})) = lower(trim(coalesce(roster_contact.email, roster_user.email, '')))
    AND position('@' in trim(coalesce(roster_contact.email, roster_user.email, ''))) > 1`;
  const rosterUserJoin = sql`
    LEFT JOIN contact roster_contact
      ON roster_contact.id::text = trim(roster_id)
    LEFT JOIN users roster_user
      ON roster_user.id::text = trim(roster_id)
      OR (
        roster_contact.email IS NOT NULL
        AND lower(trim(roster_user.email)) = lower(trim(roster_contact.email))
      )`;
  return sql`(
    EXISTS (
      SELECT 1
      FROM deal_member dm
      INNER JOIN add_deal_form f ON f.id = dm.deal_id
      CROSS JOIN LATERAL (SELECT trim(dm.contact_member_id) AS roster_id) roster
      ${rosterUserJoin}
      WHERE dm.is_draft = false
        AND (
          f.organization_id = ${orgId}::uuid
          OR EXISTS (
            SELECT 1 FROM users adder
            WHERE adder.id = dm.added_by
              AND adder.organization_id = ${orgId}::uuid
          )
        )
        AND ${emailMatchesRoster}
    )
    OR EXISTS (
      SELECT 1
      FROM deal_lp_investor lp
      INNER JOIN add_deal_form f ON f.id = lp.deal_id
      WHERE (
          f.organization_id = ${orgId}::uuid
          OR EXISTS (
            SELECT 1 FROM users adder
            WHERE adder.id = lp.added_by
              AND adder.organization_id = ${orgId}::uuid
          )
        )
        AND lower(trim(coalesce(lp.email, ''))) = lower(trim(${contact.email}))
        AND position('@' in trim(coalesce(lp.email, ''))) > 1
    )
    OR EXISTS (
      SELECT 1
      FROM deal_investment di
      INNER JOIN add_deal_form f ON f.id = di.deal_id
      CROSS JOIN LATERAL (SELECT trim(di.contact_id) AS roster_id) roster
      ${rosterUserJoin}
      WHERE di.is_draft = false
        AND f.organization_id = ${orgId}::uuid
        AND trim(di.contact_id) <> ${DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER}
        AND ${emailMatchesRoster}
    )
  )`;
}

/**
 * A sponsor from another company becomes a CRM contact of each related
 * company. Their portal account and home-company membership are unchanged.
 */
async function copySponsorIntoOrganization(
  tx: DealWriteTx,
  dealId: string,
  sponsorRosterId: string,
  addedByUserId: string,
  organizationId: string,
): Promise<boolean> {
  if (!ROSTER_CONTACT_UUID_RE.test(organizationId)) return false;
  const person = await resolveDealRosterPerson(tx, sponsorRosterId);
  if (!person) return false;
  if (sameOrganization(person.homeOrganizationId, organizationId)) return false;

  const [existing] = await tx
    .select({
      id: contact.id,
      isPortalUser: contact.isPortalUser,
    })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, organizationId),
        sql`lower(trim(${contact.email})) = ${person.email}`,
      ),
    )
    .limit(1);
  if (existing) {
    if (!existing.isPortalUser) return false;
    await tx
      .update(contact)
      .set({ isPortalUser: false, importSource: "deal_sponsor" })
      .where(eq(contact.id, existing.id));
    return true;
  }

  const createdBy = await resolveContactCreatorInOrganization(
    tx,
    organizationId,
    addedByUserId,
  );
  if (!createdBy) return false;

  const firstName = contactNameOrDash(person.firstName);
  const lastName = contactNameOrDash(person.lastName);
  await tx.insert(contact).values({
    firstName,
    lastName,
    fullName: [firstName, lastName].filter((part) => part !== "—").join(" "),
    email: person.email,
    phone: person.phone,
    note: "",
    tags: [],
    lists: [],
    owners: [],
    status: "active",
    createdBy,
    organizationId,
    isPortalUser: false,
    platformAdminOnly: false,
    visibleToUsers: false,
    relationship506b: "NO",
    referredByDealId: dealId,
    importSource: "deal_sponsor",
  });
  return true;
}

async function copySponsorIntoRelatedOrganizations(
  tx: DealWriteTx,
  dealId: string,
  sponsorRosterId: string,
  addedByUserId: string,
): Promise<boolean> {
  const person = await resolveDealRosterPerson(tx, sponsorRosterId);
  if (!person) return false;
  const organizationIds = await listOrganizationsForOutsideSponsorContact(
    tx,
    dealId,
    person.homeOrganizationId,
    addedByUserId,
  );
  let created = false;
  for (const organizationId of organizationIds) {
    if (
      await copySponsorIntoOrganization(
        tx,
        dealId,
        sponsorRosterId,
        addedByUserId,
        organizationId,
      )
    ) {
      created = true;
    }
  }
  return created;
}

/**
 * Outside sponsors belong in this company's All Contacts when the company owns
 * the deal or someone in the company added them. Sponsors from the other
 * company on that deal are not copied back.
 */
export async function syncOutsideSponsorsIntoOrganizationContacts(
  organizationId: string,
  requestedByUserId: string,
): Promise<number> {
  const orgId = String(organizationId ?? "").trim();
  const actorId = String(requestedByUserId ?? "").trim();
  if (!ROSTER_CONTACT_UUID_RE.test(orgId) || !ROSTER_CONTACT_UUID_RE.test(actorId)) {
    return 0;
  }

  const rosterRows = await db
    .select({
      dealId: dealMember.dealId,
      contactMemberId: dealMember.contactMemberId,
      addedBy: dealMember.addedBy,
    })
    .from(dealMember)
    .innerJoin(addDealForm, eq(addDealForm.id, dealMember.dealId))
    .where(
      and(
        eq(dealMember.isDraft, false),
        sql`replace(lower(trim(${dealMember.dealMemberRole})), '_', ' ') in (
          'lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor'
        )`,
        sql`(
          ${addDealForm.organizationId} = ${orgId}::uuid
          OR EXISTS (
            SELECT 1 FROM users adder
            WHERE adder.id = ${dealMember.addedBy}
              AND adder.organization_id = ${orgId}::uuid
          )
        )`,
      ),
    );
  const investmentSponsorRows = await db
    .select({
      dealId: dealInvestment.dealId,
      contactMemberId: dealInvestment.contactId,
      addedBy: sql<string | null>`null`,
    })
    .from(dealInvestment)
    .innerJoin(addDealForm, eq(addDealForm.id, dealInvestment.dealId))
    .where(
      and(
        eq(addDealForm.organizationId, orgId),
        eq(dealInvestment.isDraft, false),
        ne(
          dealInvestment.contactId,
          DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER,
        ),
        sql`replace(lower(trim(${dealInvestment.investor_role})), '_', ' ') in (
          'lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor'
        )`,
      ),
    );
  const allSponsorRows = [...rosterRows, ...investmentSponsorRows];

  let created = 0;
  let removed = 0;
  await db.transaction(async (tx) => {
    for (const row of allSponsorRows) {
      if (
        await copySponsorIntoOrganization(
          tx,
          String(row.dealId),
          String(row.contactMemberId),
          String(row.addedBy ?? actorId),
          orgId,
        )
      ) {
        created += 1;
      }
    }
    const deleted = await tx
      .delete(contact)
      .where(
        and(
          eq(contact.organizationId, orgId),
          sql`${contact.importSource} in ('deal_sponsor', 'deal_org_move')`,
          sql`NOT (${copiedContactBelongsInOrganizationSql(orgId)})`,
        ),
      )
      .returning({ id: contact.id });
    removed = deleted.length;
  });
  if (created > 0 || removed > 0) invalidateContactDirectoryCache();
  return created;
}

async function alignDealOrganizationWithLeadSponsor(
  tx: DealWriteTx,
  dealId: string,
  leadSponsorContactId: string,
): Promise<void> {
  const orgId = await resolveOrganizationIdForRosterContact(leadSponsorContactId);
  if (!orgId) return;

  const [deal] = await tx
    .select({
      organizationId: addDealForm.organizationId,
      dealName: addDealForm.dealName,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  if (!deal) return;

  const alreadyInLeadSponsorOrg = sameOrganization(
    String(deal.organizationId ?? ""),
    orgId,
  );
  if (!alreadyInLeadSponsorOrg) {
    const dealName = String(deal.dealName ?? "").trim();
    if (!DEAL_NAME_UNIQUENESS_EXEMPT.has(dealName.toLowerCase())) {
      const [dup] = await tx
        .select({ id: addDealForm.id })
        .from(addDealForm)
        .where(
          and(
            sql`lower(trim(${addDealForm.dealName})) = ${dealName.toLowerCase()}`,
            eq(addDealForm.organizationId, orgId),
            ne(addDealForm.id, dealId),
          ),
        )
        .limit(1);
      if (dup) {
        throw new DealLeadSponsorValidationError(
          "This deal cannot move to the Lead Sponsor's organization because that organization already has a deal with this name.",
        );
      }
    }

    await tx
      .update(addDealForm)
      .set({ organizationId: orgId })
      .where(eq(addDealForm.id, dealId));
  }

  await copyOutsideDealRosterIntoOrganization(
    tx,
    dealId,
    orgId,
    leadSponsorContactId,
  );
}

export async function saveDealMemberRoleForDeal(
  dealId: string,
  input: UpsertDealMemberInput & {
    replacementLeadSponsorContactId?: string;
  },
): Promise<{ newLeadSponsorContactId: string | null }> {
  const cid = input.contactMemberId.trim();
  if (!cid) return { newLeadSponsorContactId: null };
  if (input.isDraft === true) {
    await upsertDealMemberForDeal(dealId, input);
    return { newLeadSponsorContactId: null };
  }

  const members = await db
    .select({
      contactMemberId: dealMember.contactMemberId,
      dealMemberRole: dealMember.dealMemberRole,
    })
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.isDraft, false)));

  const currentKey = normalizeRosterContactId(cid);
  const replacementKey = normalizeRosterContactId(
    input.replacementLeadSponsorContactId,
  );
  const existingCurrent = members.find(
    (m) => normalizeRosterContactId(m.contactMemberId) === currentKey,
  );
  if (!existingCurrent) {
    await assertEligibleForNewDealRosterAdd(cid, input.addedByUserId);
  }

  const finalRoles = new Map<string, string>();
  for (const m of members) {
    const key = normalizeRosterContactId(m.contactMemberId);
    if (key) finalRoles.set(key, String(m.dealMemberRole ?? "").trim());
  }

  const currentWasLead = roleIsLeadSponsor(existingCurrent?.dealMemberRole);
  const currentWillBeLead = roleIsLeadSponsor(input.dealMemberRole);
  if (currentWasLead && !currentWillBeLead) {
    if (!replacementKey) {
      throw new DealLeadSponsorValidationError(
        "This Deal must have one Lead Sponsor. Please select a new Lead Sponsor.",
      );
    }
    if (replacementKey === currentKey) {
      throw new DealLeadSponsorValidationError(
        "Select another sponsor as the new Lead Sponsor.",
      );
    }
    if (
      !members.some(
        (m) => normalizeRosterContactId(m.contactMemberId) === replacementKey,
      )
    ) {
      await assertEligibleForNewDealRosterAdd(
        input.replacementLeadSponsorContactId!.trim(),
        input.addedByUserId,
      );
    }
    finalRoles.set(replacementKey, LEAD_SPONSOR_DEAL_MEMBER_ROLE);
  }

  finalRoles.set(currentKey, input.dealMemberRole?.trim() ?? "");
  const leadCount = [...finalRoles.values()].filter(roleIsLeadSponsor).length;
  if (leadCount > 1) {
    throw new DealLeadSponsorValidationError(
      "This deal already has a Lead Sponsor. Choose another role or edit the existing Lead Sponsor row.",
    );
  }
  if (leadCount < 1) {
    throw new DealLeadSponsorValidationError(
      "This Deal must have one Lead Sponsor. Please select a new Lead Sponsor.",
    );
  }

  const send = sendInvitationYesFromInput(input.sendInvitationMail);
  const now = new Date();
  const role = input.dealMemberRole?.trim() ?? "";
  let sponsorContactCreated = false;

  await db.transaction(async (tx) => {
    await tx
      .insert(dealMember)
      .values({
        dealId,
        addedBy: input.addedByUserId,
        contactMemberId: cid,
        dealMemberRole: role,
        sendInvitationMail: send,
        isDraft: false,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [dealMember.dealId, dealMember.contactMemberId],
        set: {
          addedBy: sql`COALESCE(${dealMember.addedBy}, ${input.addedByUserId}::uuid)`,
          dealMemberRole: role,
          sendInvitationMail: sqlPreserveSendInvitationMailOnUpsert(
            input.sendInvitationMail,
            dealMember.sendInvitationMail,
          ),
          isDraft: false,
          updatedAt: now,
        },
      });

    if (currentWasLead && !currentWillBeLead && replacementKey) {
      await tx
        .insert(dealMember)
        .values({
          dealId,
          addedBy: input.addedByUserId,
          contactMemberId: input.replacementLeadSponsorContactId!.trim(),
          dealMemberRole: LEAD_SPONSOR_DEAL_MEMBER_ROLE,
          sendInvitationMail: "no",
          isDraft: false,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [dealMember.dealId, dealMember.contactMemberId],
          set: {
            addedBy: sql`COALESCE(${dealMember.addedBy}, ${input.addedByUserId}::uuid)`,
            dealMemberRole: LEAD_SPONSOR_DEAL_MEMBER_ROLE,
            isDraft: false,
            updatedAt: now,
          },
        });
      await tx
        .update(dealInvestment)
        .set({ investor_role: LEAD_SPONSOR_DEAL_MEMBER_ROLE })
        .where(
          and(
            eq(dealInvestment.dealId, dealId),
            sql`lower(trim(${dealInvestment.contactId})) = ${replacementKey}`,
            eq(dealInvestment.isDraft, false),
          ),
        );
    }

    const leadSponsorContactId =
      currentWasLead && !currentWillBeLead && replacementKey
        ? input.replacementLeadSponsorContactId!.trim()
        : currentWillBeLead
          ? cid
          : "";
    if (leadSponsorContactId) {
      await alignDealOrganizationWithLeadSponsor(
        tx,
        dealId,
        leadSponsorContactId,
      );
    }
    if (roleIsSponsor(role)) {
      sponsorContactCreated = await copySponsorIntoRelatedOrganizations(
        tx,
        dealId,
        cid,
        input.addedByUserId,
      );
    }
  });

  if (sponsorContactCreated) invalidateContactDirectoryCache();

  const leadSponsorChanged =
    (currentWasLead && !currentWillBeLead) ||
    (!currentWasLead && currentWillBeLead);
  if (leadSponsorChanged) {
    try {
      const { syncDealPayerProfileToCurrentLead } = await import(
        "../billing/companyBilling.service.js"
      );
      await syncDealPayerProfileToCurrentLead(dealId);
    } catch (err) {
      console.warn("syncDealPayerProfileToCurrentLead:", dealId, err);
    }
  }

  if (currentWasLead && !currentWillBeLead && replacementKey) {
    return {
      newLeadSponsorContactId: input.replacementLeadSponsorContactId!.trim(),
    };
  }
  return { newLeadSponsorContactId: null };
}

export async function assertDealMemberLeadSponsorRoleAllowed(
  dealId: string,
  input: {
    contactMemberId: string;
    dealMemberRole: string;
    replacementLeadSponsorContactId?: string;
    isDraft?: boolean;
  },
): Promise<void> {
  const cid = input.contactMemberId.trim();
  if (!cid || input.isDraft === true) return;

  const members = await db
    .select({
      contactMemberId: dealMember.contactMemberId,
      dealMemberRole: dealMember.dealMemberRole,
    })
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.isDraft, false)));

  const currentKey = normalizeRosterContactId(cid);
  const replacementKey = normalizeRosterContactId(
    input.replacementLeadSponsorContactId,
  );
  const existingCurrent = members.find(
    (m) => normalizeRosterContactId(m.contactMemberId) === currentKey,
  );
  const currentWasLead = roleIsLeadSponsor(existingCurrent?.dealMemberRole);
  const currentWillBeLead = roleIsLeadSponsor(input.dealMemberRole);
  const finalRoles = new Map<string, string>();
  for (const m of members) {
    const key = normalizeRosterContactId(m.contactMemberId);
    if (key) finalRoles.set(key, String(m.dealMemberRole ?? "").trim());
  }

  if (currentWasLead && !currentWillBeLead) {
    if (!replacementKey) {
      throw new DealLeadSponsorValidationError(
        "This Deal must have one Lead Sponsor. Please select a new Lead Sponsor.",
      );
    }
    if (replacementKey === currentKey) {
      throw new DealLeadSponsorValidationError(
        "Select another sponsor as the new Lead Sponsor.",
      );
    }
    finalRoles.set(replacementKey, LEAD_SPONSOR_DEAL_MEMBER_ROLE);
  }

  finalRoles.set(currentKey, input.dealMemberRole?.trim() ?? "");
  const leadCount = [...finalRoles.values()].filter(roleIsLeadSponsor).length;
  if (leadCount > 1) {
    throw new DealLeadSponsorValidationError(
      "This deal already has a Lead Sponsor. Choose another role or edit the existing Lead Sponsor row.",
    );
  }
  if (leadCount < 1) {
    throw new DealLeadSponsorValidationError(
      "This Deal must have one Lead Sponsor. Please select a new Lead Sponsor.",
    );
  }
}

export async function dealMemberContactIsLeadSponsor(
  dealId: string,
  contactMemberId: string,
): Promise<boolean> {
  const cid = normalizeRosterContactId(contactMemberId);
  if (!dealId.trim() || !cid) return false;
  const [row] = await db
    .select({ dealMemberRole: dealMember.dealMemberRole })
    .from(dealMember)
    .where(
      and(
        eq(dealMember.dealId, dealId),
        sql`lower(trim(${dealMember.contactMemberId})) = ${cid}`,
        eq(dealMember.isDraft, false),
      ),
    )
    .limit(1);
  return roleIsLeadSponsor(row?.dealMemberRole);
}

export async function getDealMemberRosterEntryById(
  dealId: string,
  rowId: string,
): Promise<DealMemberRow | undefined> {
  const [row] = await db
    .select()
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.id, rowId)))
    .limit(1);
  return row;
}

/**
 * Adds the deal creator as Lead Sponsor on the roster when no other Lead Sponsor exists.
 */
export async function assignCreatorAsLeadSponsorOnDeal(
  dealId: string,
  creatorUserId: string,
): Promise<void> {
  const did = String(dealId ?? "").trim();
  const uid = String(creatorUserId ?? "").trim();
  if (!did || !uid) return;

  const [existingLeadSponsor] = await db
    .select({ contactMemberId: dealMember.contactMemberId })
    .from(dealMember)
    .where(
      and(
        eq(dealMember.dealId, did),
        eq(dealMember.isDraft, false),
        sql`lower(trim(${dealMember.dealMemberRole})) = 'lead sponsor'`,
      ),
    )
    .limit(1);

  const existingContact = normalizeContactKey(
    existingLeadSponsor?.contactMemberId ?? "",
  );
  if (existingContact && existingContact !== normalizeContactKey(uid)) {
    return;
  }

  await upsertDealMemberForDeal(did, {
    contactMemberId: uid,
    dealMemberRole: LEAD_SPONSOR_DEAL_MEMBER_ROLE,
    sendInvitationMail: "no",
    addedByUserId: uid,
  });
}

/**
 * Lists deal members for the Deal Members tab: one row per `deal_member`, with
 * commitment = **sum** of all `deal_investment` rows for that contact on this deal,
 * and other fields from the **newest** matching investment when present.
 *
 * Co-sponsors do not use this list in the UI (General Partners tab is hidden);
 * the members API returns an empty roster for that role. Investors tab is scoped separately.
 */
export async function listDealMembersMappedToInvestorApi(
  dealId: string,
  _viewerUserId?: string | null,
): Promise<ReturnType<typeof mapRowToInvestorApi>[]> {
  const members = await db
    .select()
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.isDraft, false)))
    .orderBy(desc(dealMember.updatedAt));

  const [investments, classes, lpRoster] = await Promise.all([
    listDealInvestmentsByDealId(dealId),
    listInvestorClassesByDealId(dealId),
    db
      .select()
      .from(dealLpInvestor)
      .where(
        and(
          eq(dealLpInvestor.dealId, dealId),
          eq(dealLpInvestor.isDraft, false),
        ),
      ),
  ]);
  // console.log("[Deal Members query]", {
  //   dealId,
  //   rawDealMemberRows: members.length,
  //   investmentRows: investments.length,
  //   investorClassRows: classes.length,
  //   lpRosterRows: lpRoster.length,
  // });
  const allContactIdsForCanonical = [
    ...members.map((m) => m.contactMemberId),
    ...investments.map((inv) => inv.contactId),
    ...lpRoster.map((m) => m.contactMemberId),
  ];
  const rawToCanonical =
    await mapContactIdsToCanonicalCommitmentKeys(allContactIdsForCanonical);
  const totalByCanonical = totalCommittedByCanonicalKeyFromRows(
    investments,
    rawToCanonical,
  );
  const byCanonical = groupDealInvestmentsByCanonicalKey(
    investments,
    rawToCanonical,
  );

  function canonicalOf(raw: string): string {
    const k = normalizeContactKey(raw);
    if (!k) return "";
    return rawToCanonical.get(k) ?? `id:${k}`;
  }

  const rowsForMap: DealInvestmentRow[] = [];
  const rowMeta: MemberListRowMeta[] = [];
  const coveredCanonical = new Set<string>();
  const membersForList = collapseDealMembersByCanonicalPerson(
    members,
    rawToCanonical,
  );

  for (const m of membersForList) {
    const k = normalizeContactKey(m.contactMemberId);
    const canonicalKey = k
      ? rawToCanonical.get(k) ?? `id:${k}`
      : "id:__empty__";
    const arr = byCanonical.get(canonicalKey) ?? [];
    const rosterRole = m.dealMemberRole?.trim() ?? "";
    const picked = pickLatestInvestmentForDealMember(arr);
    const classForRow = picked?.investorClass ?? "";
    const effectiveRole = rowIsGeneralPartnerForRoster(
      rosterRole,
      classForRow,
      classes,
    )
      ? GENERAL_PARTNER_ROLE_STORED
      : rosterRole || picked?.investor_role;
    if (picked) {
      /** Roster role wins over `deal_investment.investor_role` (e.g. portal `deal_participant`). */
      const merged = applyTotalCommittedToDealInvestmentRowForCanonical(
        {
          ...picked,
          investor_role: effectiveRole || picked.investor_role,
        },
        totalByCanonical,
        canonicalKey,
      );
      rowsForMap.push(merged);
    } else {
      rowsForMap.push(
        applyTotalCommittedToDealInvestmentRowForCanonical(
          {
            ...syntheticInvestmentFromDealMember(m),
            investor_role: effectiveRole || rosterRole,
          },
          totalByCanonical,
          canonicalKey,
        ),
      );
    }
    rowMeta.push({
      addedBy: m.addedBy ?? null,
      contactMemberId: m.contactMemberId,
      investorKind: picked ? undefined : "member_roster",
    });
    if (canonicalKey && canonicalKey !== "id:__empty__") {
      coveredCanonical.add(canonicalKey);
    }
  }

  for (const inv of investments) {
    const k = normalizeContactKey(inv.contactId ?? "");
    const canonical = k ? canonicalOf(k) : "";
    if (!canonical) continue;
    if (
      !shouldAddSecondaryTeamMemberSource({
        canonicalKey: canonical,
        coveredCanonical,
      }) ||
      !rowIsGeneralPartnerForRoster(
        inv.investor_role,
        inv.investorClass,
        classes,
      )
    ) {
      continue;
    }
    rowsForMap.push(
      applyTotalCommittedToDealInvestmentRowForCanonical(
        { ...inv, investor_role: GENERAL_PARTNER_ROLE_STORED },
        totalByCanonical,
        canonical,
      ),
    );
    rowMeta.push({
      addedBy: null,
      contactMemberId: inv.contactId,
    });
    coveredCanonical.add(canonical);
  }

  for (const m of lpRoster) {
    const k = normalizeContactKey(m.contactMemberId);
    const canonical = k ? canonicalOf(k) : "";
    if (
      !shouldAddSecondaryTeamMemberSource({
        canonicalKey: canonical,
        coveredCanonical,
      })
    ) {
      continue;
    }
    if (!rowIsGeneralPartnerForRoster(m.role, m.investorClass, classes)) {
      continue;
    }
    rowsForMap.push(
      applyTotalCommittedToDealInvestmentRowForCanonical(
        syntheticInvestmentFromGpLpRoster(m),
        totalByCanonical,
        canonical,
      ),
    );
    rowMeta.push({
      addedBy: m.addedBy ?? null,
      contactMemberId: m.contactMemberId,
      investorKind: "lp_roster",
    });
    coveredCanonical.add(canonical);
  }

  const patched = await enrichInvestorRolesForDealRows(dealId, rowsForMap);
  const resolved = await resolveUsersByContactIds(patched);
  const profileNames = await resolveUserInvestorProfileNamesByIds(
    patched.map((r) => String(r.userInvestorProfileId ?? "")),
  );
  const addedByNames = await resolveUserDisplayNamesByIds(
    rowMeta.map((m) => m.addedBy),
  );

  const memberContactKeys = new Set<string>();
  for (const m of rowMeta) {
    const k = normalizeContactKey(m.contactMemberId);
    if (k) memberContactKeys.add(k);
  }
  const committedFromAddedInvestors =
    await sumCommittedFromInvestorsAddedByMemberContacts(
      dealId,
      memberContactKeys,
    );

  const invitationMailFlags = await loadInvitationMailSentFlags(
    dealId,
    patched,
    new Set<string>(),
  );

  const result = patched.map((r, i) => {
    const m = rowMeta[i];
    const invitationMailSent = invitationMailFlags[i] === true;
    const base = mapRowToInvestorApi(r, resolved, { invitationMailSent });
    const addedByRaw = m?.addedBy;
    const key = addedByRaw ? String(addedByRaw).toLowerCase() : "";
    const addedByDisplayName =
      key && addedByNames.has(key) ? addedByNames.get(key)! : "—";
    const memberCk = normalizeContactKey(m?.contactMemberId ?? "");
    const fromAdded = memberCk
      ? (committedFromAddedInvestors.get(memberCk) ?? 0)
      : 0;
    const profileKey = String(r.userInvestorProfileId ?? "")
      .trim()
      .toLowerCase();
    const userInvestorProfileName = profileKey
      ? profileNames.get(profileKey)
      : undefined;
    return {
      ...base,
      addedByDisplayName,
      addedInvestorsCommitted: formatCommittedUsdWhole(fromAdded),
      ...(userInvestorProfileName
        ? { userInvestorProfileName }
        : {}),
      ...(m?.investorKind ? { investorKind: m.investorKind } : {}),
    };
  });
  console.log("[Deal Members result]", {
    dealId,
    mergedRowsBeforeMapping: patched.length,
    returnedRows: result.length,
  });
  return result;
}

function isPlaceholderRosterContact(raw: string): boolean {
  const key = normalizeContactKey(raw);
  return (
    !key ||
    key === DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER.toLowerCase()
  );
}

/**
 * Contacts who currently fill the Lead Sponsor slot. A saved `deal_member` role
 * wins over `deal_investment.investor_role` for the same person.
 */
async function leadSponsorContactKeysForDeal(
  dealId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const memberRoleByContact = new Map<string, string>();
  const members = await db
    .select({
      contactMemberId: dealMember.contactMemberId,
      dealMemberRole: dealMember.dealMemberRole,
    })
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.isDraft, false)));
  for (const m of members) {
    if (isPlaceholderRosterContact(m.contactMemberId)) continue;
    const key = normalizeContactKey(m.contactMemberId);
    memberRoleByContact.set(key, m.dealMemberRole ?? "");
    if (roleIsLeadSponsor(m.dealMemberRole)) keys.add(key);
  }

  const investments = await db
    .select({
      contactId: dealInvestment.contactId,
      investorRole: dealInvestment.investor_role,
    })
    .from(dealInvestment)
    .where(eq(dealInvestment.dealId, dealId));
  for (const inv of investments) {
    if (isPlaceholderRosterContact(inv.contactId)) continue;
    const key = normalizeContactKey(inv.contactId);
    if (memberRoleByContact.has(key)) continue;
    if (roleIsLeadSponsor(inv.investorRole)) keys.add(key);
  }
  return keys;
}

async function contactKeyForRosterDelete(
  dealId: string,
  rowId: string,
): Promise<string> {
  const [member] = await db
    .select({ contactMemberId: dealMember.contactMemberId })
    .from(dealMember)
    .where(and(eq(dealMember.id, rowId), eq(dealMember.dealId, dealId)))
    .limit(1);
  if (member) return normalizeContactKey(member.contactMemberId);

  const [inv] = await db
    .select({ contactId: dealInvestment.contactId })
    .from(dealInvestment)
    .where(and(eq(dealInvestment.id, rowId), eq(dealInvestment.dealId, dealId)))
    .limit(1);
  if (inv) return normalizeContactKey(inv.contactId);

  const [lp] = await db
    .select({ contactMemberId: dealLpInvestor.contactMemberId })
    .from(dealLpInvestor)
    .where(and(eq(dealLpInvestor.id, rowId), eq(dealLpInvestor.dealId, dealId)))
    .limit(1);
  if (lp) return normalizeContactKey(lp.contactMemberId);
  return "";
}

/**
 * A deal must keep a Lead Sponsor. Deleting the only one is rejected.
 */
async function assertRosterDeleteKeepsLeadSponsor(
  dealId: string,
  rowId: string,
): Promise<void> {
  const targetKey = await contactKeyForRosterDelete(dealId, rowId);
  if (!targetKey || isPlaceholderRosterContact(targetKey)) return;
  const leads = await leadSponsorContactKeysForDeal(dealId);
  if (!leads.has(targetKey)) return;
  const remaining = [...leads].filter((key) => key !== targetKey);
  if (remaining.length < 1) {
    throw new DealLeadSponsorValidationError(LEAD_SPONSOR_REQUIRED_MESSAGE);
  }
}

function joinedPersonName(
  first: string | null | undefined,
  last: string | null | undefined,
): string {
  return [first, last]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function preferLabel(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text && text !== "—" && text !== "Draft") return text;
  }
  return "";
}

/** Contact or portal user display name for a roster contact id. */
async function personLabelByRosterId(id: string): Promise<string> {
  const key = id.trim();
  if (!ROSTER_CONTACT_UUID_RE.test(key)) return "";

  const contacts = await db
    .select({
      fullName: contact.fullName,
      firstName: contact.firstName,
      lastName: contact.lastName,
    })
    .from(contact)
    .where(eq(contact.id, key))
    .limit(1);
  const contactRow = contacts[0];
  if (contactRow) {
    const label = preferLabel(
      contactRow.fullName,
      joinedPersonName(contactRow.firstName, contactRow.lastName),
    );
    if (label) return label;
  }

  const userRows = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, key))
    .limit(1);
  const userRow = userRows[0];
  if (!userRow) return "";
  return preferLabel(
    joinedPersonName(userRow.firstName, userRow.lastName),
    userRow.username,
    userRow.email,
  );
}

async function deletedByLabel(userId: string): Promise<string> {
  const rows = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userRow = rows[0];
  if (!userRow) return "";
  return preferLabel(
    joinedPersonName(userRow.firstName, userRow.lastName),
    userRow.username,
    userRow.email,
  );
}

type RosterRemovalSnapshot = {
  removedRowId: string;
  removedContactId: string;
  removedName: string;
  removedRole: string;
  mode: "investment" | "member" | "lp";
};

async function loadRosterRemovalSnapshot(
  dealId: string,
  rowId: string,
): Promise<RosterRemovalSnapshot | null> {
  const invRows = await db
    .select()
    .from(dealInvestment)
    .where(and(eq(dealInvestment.id, rowId), eq(dealInvestment.dealId, dealId)))
    .limit(1);
  if (invRows.length > 0) {
    const investment = invRows[0]!;
    const contactId = investment.contactId.trim();
    const memberRows = contactId
      ? await db
          .select({
            name: dealMember.dealMemberName,
            role: dealMember.dealMemberRole,
          })
          .from(dealMember)
          .where(
            and(
              eq(dealMember.dealId, dealId),
              eq(dealMember.contactMemberId, contactId),
            ),
          )
          .limit(1)
      : [];
    const member = memberRows[0];
    return {
      removedRowId: rowId,
      removedContactId: contactId,
      removedName: preferLabel(
        investment.contactDisplayName,
        member?.name,
        await personLabelByRosterId(contactId),
      ),
      removedRole: preferLabel(investment.investor_role, member?.role),
      mode: "investment",
    };
  }

  const memberRows = await db
    .select()
    .from(dealMember)
    .where(and(eq(dealMember.id, rowId), eq(dealMember.dealId, dealId)))
    .limit(1);
  if (memberRows.length > 0) {
    const member = memberRows[0]!;
    const contactId = member.contactMemberId.trim();
    return {
      removedRowId: rowId,
      removedContactId: contactId,
      removedName: preferLabel(
        member.dealMemberName,
        await personLabelByRosterId(contactId),
      ),
      removedRole: preferLabel(member.dealMemberRole),
      mode: "member",
    };
  }

  const lpRows = await db
    .select()
    .from(dealLpInvestor)
    .where(and(eq(dealLpInvestor.id, rowId), eq(dealLpInvestor.dealId, dealId)))
    .limit(1);
  if (lpRows.length > 0) {
    const lp = lpRows[0]!;
    const contactId = String(lp.contactMemberId ?? "").trim();
    return {
      removedRowId: rowId,
      removedContactId: contactId,
      removedName: preferLabel(
        lp.investorName,
        await personLabelByRosterId(contactId),
      ),
      removedRole: preferLabel(lp.role),
      mode: "lp",
    };
  }

  return null;
}

async function deleteSnapshottedRosterEntry(
  tx: DealWriteTx,
  dealId: string,
  snapshot: RosterRemovalSnapshot,
): Promise<void> {
  const contactId = snapshot.removedContactId;
  if (snapshot.mode === "investment") {
    if (!contactId) {
      await tx
        .delete(dealInvestment)
        .where(
          and(eq(dealInvestment.id, snapshot.removedRowId), eq(dealInvestment.dealId, dealId)),
        );
      return;
    }
    await tx
      .delete(dealInvestment)
      .where(
        and(eq(dealInvestment.dealId, dealId), eq(dealInvestment.contactId, contactId)),
      );
    await tx
      .delete(dealMember)
      .where(
        and(eq(dealMember.dealId, dealId), eq(dealMember.contactMemberId, contactId)),
      );
    await tx
      .delete(dealLpInvestor)
      .where(
        and(
          eq(dealLpInvestor.dealId, dealId),
          eq(dealLpInvestor.contactMemberId, contactId),
        ),
      );
    return;
  }

  if (snapshot.mode === "member") {
    await tx
      .delete(dealMember)
      .where(
        and(eq(dealMember.id, snapshot.removedRowId), eq(dealMember.dealId, dealId)),
      );
    return;
  }

  if (!contactId) {
    await tx
      .delete(dealLpInvestor)
      .where(
        and(eq(dealLpInvestor.id, snapshot.removedRowId), eq(dealLpInvestor.dealId, dealId)),
      );
    return;
  }
  await tx
    .delete(dealInvestment)
    .where(
      and(eq(dealInvestment.dealId, dealId), eq(dealInvestment.contactId, contactId)),
    );
  await tx
    .delete(dealMember)
    .where(
      and(eq(dealMember.dealId, dealId), eq(dealMember.contactMemberId, contactId)),
    );
  await tx
    .delete(dealLpInvestor)
    .where(
      and(
        eq(dealLpInvestor.dealId, dealId),
        eq(dealLpInvestor.contactMemberId, contactId),
      ),
    );
}

/**
 * Removes a member from the deal roster. `rowId` is either `deal_investment.id`
 * (row merged with latest investment) or `deal_member.id` (member-only row).
 * When an investment id is passed, deletes all investments for that contact on
 * this deal, then the `deal_member` row.
 * Writes `deal_member_removal_logs` with the user who deleted the row.
 */
export async function deleteDealMemberRosterEntry(
  dealId: string,
  rowId: string,
  deletedByUserId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await assertRosterDeleteKeepsLeadSponsor(dealId, rowId);
  const snapshot = await loadRosterRemovalSnapshot(dealId, rowId);
  if (!snapshot) return { ok: false, message: "Member or investment not found" };

  const actorUserId = deletedByUserId.trim();
  const deletedByName = await deletedByLabel(actorUserId);

  await db.transaction(async (tx) => {
    await deleteSnapshottedRosterEntry(tx, dealId, snapshot);
    await tx.insert(dealMemberRemovalLogs).values({
      dealId,
      removedRowId: snapshot.removedRowId,
      removedContactId: snapshot.removedContactId,
      removedName: snapshot.removedName,
      removedRole: snapshot.removedRole,
      deletedByUserId: actorUserId,
      deletedByName,
    });
  });

  return { ok: true };
}

function isLeadSponsorStoredRole(role: string | null | undefined): boolean {
  const t = String(role ?? "").trim().toLowerCase();
  return t === "lead sponsor" || t === "lead_sponsor";
}

function rosterPersonDisplayName(row: {
  displayName?: string;
  userDisplayName?: string;
}): string {
  const display = String(row.displayName ?? "").trim();
  if (display && display !== "—" && display !== "Draft") return display;
  const user = String(row.userDisplayName ?? "").trim();
  if (user && user !== "—") return user;
  return "";
}

/**
 * Lead sponsor person name for investor-facing surfaces (Invest Now, investments list).
 * Prefers `deal_member` Lead Sponsor; falls back to a matching `deal_investment` row.
 */
export async function resolveDealLeadSponsorDisplayName(
  dealId: string,
): Promise<string> {
  const d = String(dealId ?? "").trim();
  if (!d) return "";

  const members = await listDealMembersMappedToInvestorApi(d);
  const leadMember = members.find((m) =>
    isLeadSponsorStoredRole(m.investorRole),
  );
  if (leadMember) {
    const name = rosterPersonDisplayName(leadMember);
    if (name) return name;
  }

  const investments = await listDealInvestmentsByDealId(d);
  const leadInvestment = investments.find(
    (inv) =>
      isLeadSponsorStoredRole(inv.investor_role) &&
      String(inv.contactId ?? "").trim() !==
        DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER,
  );
  if (!leadInvestment) return "";

  const resolved = await resolveUsersByContactIds([leadInvestment]);
  const api = mapRowToInvestorApi(leadInvestment, resolved, {});
  return rosterPersonDisplayName(api);
}
