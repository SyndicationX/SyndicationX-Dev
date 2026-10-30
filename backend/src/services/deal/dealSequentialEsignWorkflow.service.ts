import { eq } from "drizzle-orm";
import {
  esignSendInvestorActionComplete,
  esignSendReadyForSponsorCounterSign,
  parseEsignStatusBundle,
  type StoredDealInvestorEsignSend,
} from "../../constants/deal-investor-esign-status.js";
import {
  resolveEsignSignflowSigningOrder,
  resolveEsignSignflowWorkflowType,
  type EsignSignflowWorkflowType,
} from "../../constants/esignSigningWorkflow.js";
import { db } from "../../database/db.js";
import { dealInvestment } from "../../schema/deal.schema/deal-investment.schema.js";
import { dealLpInvestor } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import {
  findEsignTemplateFile,
  getDealEsignTemplatesState,
  type EsignTemplateFileRecord,
} from "./dealEsignTemplates.service.js";
import type { InvestorEsignRowTarget } from "./dealMemberEsignStatus.service.js";
import { resolveEmailForContactMemberId } from "./dealMemberInvitationEmail.service.js";

export type DealEsignInvestorQueueEntry = {
  target: InvestorEsignRowTarget;
  rowId: string;
  displayName: string;
  email: string;
  /** Roster / investment `contact_id` — used to dedupe LP + investment rows for one person. */
  contactMemberId: string;
  createdAtMs: number;
  esignStatusJson: string | null;
};

function normContactKey(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

function normEmail(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

function investorContactKey(entry: DealEsignInvestorQueueEntry): string {
  return normContactKey(entry.contactMemberId) || normEmail(entry.email);
}

function pickQueueDisplayName(
  primary: DealEsignInvestorQueueEntry,
  secondary?: DealEsignInvestorQueueEntry,
): string {
  for (const candidate of [
    primary.email,
    secondary?.email,
    primary.displayName,
    secondary?.displayName,
  ]) {
    const t = String(candidate ?? "").trim();
    if (t) return t;
  }
  return "Investor";
}

/** Same invited person may have both LP roster + investment rows with eSign — count once. */
function dedupeSequentialInvestorQueue(
  entries: DealEsignInvestorQueueEntry[],
): DealEsignInvestorQueueEntry[] {
  const groups = new Map<string, DealEsignInvestorQueueEntry[]>();
  for (const entry of entries) {
    const key = investorContactKey(entry) || `row:${entry.rowId}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const merged: DealEsignInvestorQueueEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }

    const investments = group.filter((e) => e.target.table === "investment");
    const lps = group.filter((e) => e.target.table === "lp");

    if (investments.length > 0) {
      for (const inv of investments) {
        const lp = lps[0];
        merged.push({
          ...inv,
          createdAtMs: lp
            ? Math.min(inv.createdAtMs, lp.createdAtMs)
            : inv.createdAtMs,
          displayName: pickQueueDisplayName(inv, lp),
          email: normEmail(inv.email) || normEmail(lp?.email),
          contactMemberId: inv.contactMemberId || lp?.contactMemberId || "",
        });
      }
      continue;
    }

    group.sort((a, b) => a.createdAtMs - b.createdAtMs);
    merged.push(group[0]!);
  }

  merged.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    return a.rowId.localeCompare(b.rowId);
  });
  return merged;
}

function targetKey(target: InvestorEsignRowTarget): string {
  return `${target.table}:${target.id}`;
}

function committedNumericFromAmountFields(
  primary: string | null | undefined,
  extras: string[] | null | undefined,
): number {
  const raw = [primary, ...(extras ?? []).map(String)];
  const nums = raw
    .map((s) => parseFloat(String(s).replace(/[^0-9.-]/g, "")))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0);
}

function bundleHasEsignSent(esignStatusJson: string | null | undefined): boolean {
  const bundle = parseEsignStatusBundle(esignStatusJson);
  return Boolean(bundle?.sends.some((s) => s.sentAt?.trim()));
}

async function contactKeyForEsignTarget(
  dealId: string,
  target: InvestorEsignRowTarget,
): Promise<string> {
  if (target.table === "investment") {
    const [row] = await db
      .select({ contactId: dealInvestment.contactId })
      .from(dealInvestment)
      .where(
        eq(dealInvestment.id, target.id),
      )
      .limit(1);
    const fromContact = normContactKey(row?.contactId);
    if (fromContact) return fromContact;
  } else {
    const [row] = await db
      .select({
        contactMemberId: dealLpInvestor.contactMemberId,
        email: dealLpInvestor.email,
      })
      .from(dealLpInvestor)
      .where(eq(dealLpInvestor.id, target.id))
      .limit(1);
    const fromContact = normContactKey(row?.contactMemberId);
    if (fromContact) return fromContact;
    const fromEmail = normEmail(row?.email);
    if (fromEmail) return fromEmail;
  }

  return "";
}

/** Match queue row by target id or deduped contact (LP roster vs investment row). */
async function findQueueIndexForTarget(
  dealId: string,
  queue: DealEsignInvestorQueueEntry[],
  target: InvestorEsignRowTarget,
): Promise<number> {
  const key = targetKey(target);
  const direct = queue.findIndex((e) => targetKey(e.target) === key);
  if (direct >= 0) return direct;

  const contactKey = await contactKeyForEsignTarget(dealId, target);
  if (!contactKey) return -1;

  return queue.findIndex(
    (e) => investorContactKey(e) === contactKey,
  );
}

/** Queue row for an eSign target (direct id or deduped contact match). */
export async function findQueueEntryForEsignTarget(
  dealId: string,
  queue: DealEsignInvestorQueueEntry[],
  target: InvestorEsignRowTarget,
): Promise<DealEsignInvestorQueueEntry | null> {
  const index = await findQueueIndexForTarget(dealId, queue, target);
  return index >= 0 ? (queue[index] ?? null) : null;
}

function sendUsesSequentialInvestorFirst(
  send: StoredDealInvestorEsignSend,
  templates: Awaited<ReturnType<typeof getDealEsignTemplatesState>>,
): boolean {
  const fileId = send.documents?.[0]?.fileId?.trim();
  if (!fileId) return false;
  const file = findEsignTemplateFile(templates, fileId);
  if (!file) return false;
  return dealTemplateUsesSequentialInvestorFirst(file);
}

export function dealTemplateUsesSequentialInvestorFirst(
  file: EsignTemplateFileRecord,
): boolean {
  const workflowType = resolveEsignSignflowWorkflowType(file);
  const signingOrder = resolveEsignSignflowSigningOrder(file);
  return workflowType === "sequential" && signingOrder === "investor_first";
}

/** Sequential investor-first: sponsor countersigns after the investor. Parallel does not wait. */
export function dealTemplateUsesInvestorFirstCounterSign(
  file: EsignTemplateFileRecord,
): boolean {
  return (
    resolveEsignSignflowWorkflowType(file) === "sequential" &&
    resolveEsignSignflowSigningOrder(file) === "investor_first"
  );
}

function sendUsesInvestorFirstCounterSign(
  send: StoredDealInvestorEsignSend,
  templates: Awaited<ReturnType<typeof getDealEsignTemplatesState>>,
): boolean {
  const fileId = send.documents?.[0]?.fileId?.trim();
  if (!fileId) return false;
  const file = findEsignTemplateFile(templates, fileId);
  if (!file) return false;
  return dealTemplateUsesInvestorFirstCounterSign(file);
}

/**
 * Investors on the deal (invited LP roster and commitments with capital or an eSign send).
 * Used to resolve who signed. Signing is not ordered across this list.
 */
export async function listDealEsignInvestorQueue(
  dealId: string,
): Promise<DealEsignInvestorQueueEntry[]> {
  const id = dealId.trim();
  if (!id) return [];

  const [investments, roster] = await Promise.all([
    db
      .select({
        id: dealInvestment.id,
        contactDisplayName: dealInvestment.contactDisplayName,
        contactId: dealInvestment.contactId,
        esignStatusJson: dealInvestment.esignStatusJson,
        commitmentAmount: dealInvestment.commitmentAmount,
        extraContributionAmounts: dealInvestment.extraContributionAmounts,
        createdAt: dealInvestment.createdAt,
      })
      .from(dealInvestment)
      .where(eq(dealInvestment.dealId, id)),
    db
      .select({
        id: dealLpInvestor.id,
        email: dealLpInvestor.email,
        contactMemberId: dealLpInvestor.contactMemberId,
        esignStatusJson: dealLpInvestor.esignStatusJson,
        committed_amount: dealLpInvestor.committed_amount,
        createdAt: dealLpInvestor.createdAt,
      })
      .from(dealLpInvestor)
      .where(eq(dealLpInvestor.dealId, id)),
  ]);

  const out: DealEsignInvestorQueueEntry[] = [];

  for (const row of investments) {
    const hasEsignSent = bundleHasEsignSent(row.esignStatusJson);
    const hasCommitment =
      committedNumericFromAmountFields(
        row.commitmentAmount,
        row.extraContributionAmounts as string[] | null,
      ) > 0;
    if (!hasEsignSent && !hasCommitment) continue;

    const contactMemberId = String(row.contactId ?? "").trim();
    const resolvedEmail = contactMemberId
      ? normEmail(await resolveEmailForContactMemberId(contactMemberId))
      : "";
    const displayName =
      row.contactDisplayName?.trim() ||
      resolvedEmail ||
      "Investor";
    out.push({
      target: { table: "investment", id: row.id },
      rowId: row.id,
      displayName,
      email: resolvedEmail,
      contactMemberId,
      createdAtMs: row.createdAt ? new Date(row.createdAt).getTime() : 0,
      esignStatusJson: row.esignStatusJson,
    });
  }

  for (const row of roster) {
    const contactMemberId = String(row.contactMemberId ?? "").trim();
    const rowEmail = normEmail(row.email);
    const resolvedEmail =
      rowEmail ||
      (contactMemberId
        ? normEmail(await resolveEmailForContactMemberId(contactMemberId))
        : "");
    out.push({
      target: { table: "lp", id: row.id },
      rowId: row.id,
      displayName: rowEmail || resolvedEmail || "Investor",
      email: resolvedEmail,
      contactMemberId,
      createdAtMs: row.createdAt ? new Date(row.createdAt).getTime() : 0,
      esignStatusJson: row.esignStatusJson,
    });
  }

  return dedupeSequentialInvestorQueue(out);
}

export function sendInvestorPhaseComplete(
  send: StoredDealInvestorEsignSend,
): boolean {
  return (
    esignSendReadyForSponsorCounterSign(send) ||
    esignSendInvestorActionComplete(send)
  );
}

export async function dealHasSequentialInvestorFirstEsign(
  dealId: string,
): Promise<boolean> {
  const templates = await getDealEsignTemplatesState(dealId);
  const queue = await listDealEsignInvestorQueue(dealId);
  for (const entry of queue) {
    const bundle = parseEsignStatusBundle(entry.esignStatusJson);
    if (!bundle) continue;
    for (const send of bundle.sends) {
      if (!send.sentAt?.trim()) continue;
      if (sendUsesSequentialInvestorFirst(send, templates)) return true;
    }
  }
  return templates.files.some(dealTemplateUsesSequentialInvestorFirst);
}

/** Deal uses sequential investor-then-sponsor counter-sign. */
export async function dealHasInvestorFirstCounterSignEsign(
  dealId: string,
): Promise<boolean> {
  const templates = await getDealEsignTemplatesState(dealId);
  const queue = await listDealEsignInvestorQueue(dealId);
  for (const entry of queue) {
    const bundle = parseEsignStatusBundle(entry.esignStatusJson);
    if (!bundle) continue;
    for (const send of bundle.sends) {
      if (!send.sentAt?.trim()) continue;
      if (sendUsesInvestorFirstCounterSign(send, templates)) return true;
    }
  }
  return templates.files.some(dealTemplateUsesInvestorFirstCounterSign);
}

export type DealSequentialInvestorSignAccess =
  | { allowed: true }
  | {
      allowed: false;
      /** Investor-safe copy — never names other signers. */
      message: string;
    };

/**
 * Sequential order is investor then sponsor on that investor's document.
 * Investors are not queued against each other — any investor may sign.
 */
export async function evaluateDealSequentialInvestorSignAccess(
  _dealId: string,
  _target: InvestorEsignRowTarget,
): Promise<DealSequentialInvestorSignAccess> {
  return { allowed: true };
}

/**
 * Sponsor Documents tab shows each investor's signed PDF as soon as that
 * investor finishes. The sponsor then countersigns that document.
 */
export async function sequentialWorkflowSponsorDocsGateOpen(
  _dealId: string,
): Promise<boolean> {
  return true;
}

/** LP portal Documents tab follows the same per-investor document gate. */
export const sequentialWorkflowInvestorPortalDocsGateOpen =
  sequentialWorkflowSponsorDocsGateOpen;

export function resolveWorkflowTypeForSend(
  send: StoredDealInvestorEsignSend,
  templates: Awaited<ReturnType<typeof getDealEsignTemplatesState>>,
): EsignSignflowWorkflowType {
  const fileId = send.documents?.[0]?.fileId?.trim();
  if (!fileId) return "parallel";
  const file = findEsignTemplateFile(templates, fileId);
  if (!file) return "parallel";
  return resolveEsignSignflowWorkflowType(file);
}

/** Shared-with ids for LP portal document audience matching. */
export async function resolveInvestorDocumentAudienceIds(
  dealId: string,
  target: InvestorEsignRowTarget,
): Promise<string[]> {
  const ids = new Set<string>();
  ids.add(target.id);

  if (target.table === "investment") {
    const [row] = await db
      .select({
        contactId: dealInvestment.contactId,
        userInvestorProfileId: dealInvestment.userInvestorProfileId,
        profileId: dealInvestment.profileId,
      })
      .from(dealInvestment)
      .where(eq(dealInvestment.id, target.id))
      .limit(1);
    for (const raw of [
      row?.contactId,
      row?.userInvestorProfileId,
      row?.profileId,
    ]) {
      const v = raw?.trim();
      if (v) ids.add(v);
    }
  } else {
    const [row] = await db
      .select({
        contactMemberId: dealLpInvestor.contactMemberId,
        userInvestorProfileId: dealLpInvestor.userInvestorProfileId,
        profileId: dealLpInvestor.profileId,
      })
      .from(dealLpInvestor)
      .where(eq(dealLpInvestor.id, target.id))
      .limit(1);
    for (const raw of [
      row?.contactMemberId,
      row?.userInvestorProfileId,
      row?.profileId,
    ]) {
      const v = raw?.trim();
      if (v) ids.add(v);
    }
  }

  return [...ids];
}
