import { pool } from "../../database/db.js";
import {
  normalizeEsignSignflowWorkflowType,
  resolveEsignSignflowSigningOrder,
  resolveEsignSignflowWorkflowType,
  resolveSignFlowRecipientOrders,
  type EsignSignflowSigningOrder,
  type EsignSignflowWorkflowType,
} from "../../constants/esignSigningWorkflow.js";
import {
  getSignFlowDocument,
  isSignFlowOpenSponsorRecipient,
  patchSignFlowDocument,
  SIGNFLOW_OPEN_SPONSOR_NAME,
  signFlowOpenSponsorSignerName,
  signFlowRecipientHasSigned,
} from "../esign/signflow.service.js";
import type { EsignTemplateFileRecord } from "./dealEsignTemplates.service.js";

export type DealSponsorSigner = {
  email: string;
  name: string;
};

function formatSignerName(row: {
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  contact_name: string | null;
  email: string;
}): string {
  const fromUser = [row.first_name, row.last_name]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fromUser) return fromUser;
  const contactName = row.contact_name?.trim();
  if (contactName) return contactName;
  const username = row.username?.trim();
  if (username) return username;
  return row.email;
}

/** Resolves the lead sponsor (or admin sponsor fallback) email for eSign sends. */
export async function resolveDealLeadSponsorSigner(
  dealId: string,
): Promise<DealSponsorSigner | null> {
  const d = String(dealId ?? "").trim();
  if (!d) return null;

  const res = await pool.query<{
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    contact_name: string | null;
  }>(
    `SELECT
       email,
       first_name,
       last_name,
       username,
       contact_name
     FROM (
       SELECT
         COALESCE(
           NULLIF(trim(u.email), ''),
           NULLIF(trim(c.email), ''),
           CASE
             WHEN trim(dm.contact_member_id) LIKE '%@%' THEN lower(trim(dm.contact_member_id))
           END
         ) AS email,
         u.first_name,
         u.last_name,
         u.username,
         trim(concat_ws(' ', c.first_name, c.last_name)) AS contact_name,
         CASE lower(trim(dm.deal_member_role))
           WHEN 'lead sponsor' THEN 0
           WHEN 'admin sponsor' THEN 1
           ELSE 2
         END AS role_rank
       FROM deal_member dm
       LEFT JOIN users u ON trim(dm.contact_member_id) = u.id::text
       LEFT JOIN contact c ON c.id::text = trim(both from dm.contact_member_id)
       WHERE dm.deal_id = $1::uuid
         AND lower(trim(dm.deal_member_role)) IN ('lead sponsor', 'admin sponsor')

       UNION ALL

       SELECT
         COALESCE(
           NULLIF(trim(u.email), ''),
           NULLIF(trim(c.email), ''),
           CASE
             WHEN trim(di.contact_id) LIKE '%@%' THEN lower(trim(di.contact_id))
           END
         ) AS email,
         u.first_name,
         u.last_name,
         u.username,
         trim(concat_ws(' ', c.first_name, c.last_name)) AS contact_name,
         CASE lower(trim(di.investor_role))
           WHEN 'lead sponsor' THEN 0
           WHEN 'admin sponsor' THEN 1
           ELSE 2
         END AS role_rank
       FROM deal_investment di
       LEFT JOIN users u ON trim(di.contact_id) = u.id::text
       LEFT JOIN contact c ON c.id::text = trim(both from di.contact_id)
       WHERE di.deal_id = $1::uuid
         AND trim(di.contact_id) <> '__portal_investment_autosave__'
         AND lower(trim(di.investor_role)) IN ('lead sponsor', 'admin sponsor')
     ) sponsors
     WHERE email IS NOT NULL AND trim(email) <> ''
     ORDER BY role_rank
     LIMIT 1`,
    [d],
  );

  const row = res.rows[0];
  const email = row?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;

  return {
    email,
    name: formatSignerName({ ...row, email }),
  };
}

function findTemplateRecipientByRole(
  recipients: NonNullable<Awaited<ReturnType<typeof getSignFlowDocument>>["recipients"]>,
  roleKeys: string[],
): { id?: string; name?: string; email?: string; role?: string; color?: string; order?: number; profileType?: string } | undefined {
  const keys = new Set(roleKeys.map((k) => k.toLowerCase()));
  return recipients.find((r) => {
    const role = String(r.role ?? "").trim().toLowerCase();
    const id = String(r.id ?? "").trim().toLowerCase();
    return keys.has(role) || keys.has(id);
  });
}

export async function syncSignflowTemplateSigningWorkflow(
  documentId: string,
  workflowType: EsignSignflowWorkflowType,
  signingOrder: EsignSignflowSigningOrder,
): Promise<void> {
  const doc = await getSignFlowDocument(documentId);
  const existing = [...(doc.recipients ?? [])];
  if (existing.length === 0) {
    await patchSignFlowDocument(documentId, { workflowType });
    return;
  }

  const investorRecipient = findTemplateRecipientByRole(existing, [
    "buyer",
    "investor",
    "rec_investor",
    "rec_1",
    "recipient_a",
  ]);
  const sponsorRecipient = findTemplateRecipientByRole(existing, [
    "seller",
    "sponsor",
    "rec_sponsor",
    "rec_2",
    "recipient_b",
  ]);

  const { investorOrder, sponsorOrder } = resolveSignFlowRecipientOrders(
    workflowType,
    signingOrder,
  );

  const recipients = existing.map((r) => {
    const id = String(r.id ?? "").trim();
    const role = String(r.role ?? "").trim().toLowerCase();
    const isInvestor =
      r === investorRecipient ||
      role.includes("investor") ||
      role.includes("buyer") ||
      id === "rec_investor" ||
      id === "rec_1";
    const isSponsor =
      r === sponsorRecipient ||
      role.includes("sponsor") ||
      role.includes("seller") ||
      id === "rec_sponsor" ||
      id === "rec_2";
    if (isInvestor) {
      return { ...r, order: investorOrder };
    }
    if (isSponsor) {
      return { ...r, order: sponsorOrder };
    }
    return r;
  });

  const workflowUnchanged =
    String(doc.workflowType ?? "").trim().toLowerCase() === workflowType;
  const ordersUnchanged = recipients.every(
    (recipient, index) =>
      Number(recipient.order) === Number(existing[index]?.order),
  );
  if (workflowUnchanged && ordersUnchanged) return;

  await patchSignFlowDocument(documentId, {
    workflowType,
    recipients,
    fields: doc.fields ?? [],
  });
}

export function resolveSigningWorkflowFromTemplateFile(
  file: EsignTemplateFileRecord,
): {
  workflowType: EsignSignflowWorkflowType;
  signingOrder: EsignSignflowSigningOrder;
} {
  return {
    workflowType: resolveEsignSignflowWorkflowType(file),
    signingOrder: resolveEsignSignflowSigningOrder(file),
  };
}

export function inferSigningWorkflowFromSignFlowDocument(doc: {
  workflowType?: string | null;
  recipients?: Array<{ role?: string; order?: number; id?: string }> | null;
}): {
  workflowType?: EsignSignflowWorkflowType;
  signingOrder?: EsignSignflowSigningOrder;
} {
  const workflowType = normalizeEsignSignflowWorkflowType(doc.workflowType);
  const recipients = doc.recipients ?? [];
  const investor = findTemplateRecipientByRole(recipients, [
    "buyer",
    "investor",
    "rec_investor",
  ]);
  const sponsor = findTemplateRecipientByRole(recipients, [
    "seller",
    "sponsor",
    "rec_sponsor",
  ]);
  const investorOrder = Number(investor?.order) || 1;
  const sponsorOrder = Number(sponsor?.order) || 2;
  const signingOrder: EsignSignflowSigningOrder =
    sponsorOrder < investorOrder ? "sponsor_first" : "investor_first";

  return {
    workflowType: workflowType ?? undefined,
    signingOrder:
      investor && sponsor && workflowType === "sequential"
        ? signingOrder
        : undefined,
  };
}

export type DealMemberSignerOption = {
  rowId: string;
  name: string;
  email: string;
  role: string;
};

const SPONSOR_MEMBER_ROLES_SQL =
  "('lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor')";

/** Deal members eligible to counter-sign as sponsor on eSign documents. */
export async function listDealSponsorSignerOptions(
  dealId: string,
): Promise<DealMemberSignerOption[]> {
  const d = String(dealId ?? "").trim();
  if (!d) return [];

  const res = await pool.query<{
    row_id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    contact_name: string | null;
    role: string | null;
  }>(
    `SELECT
       row_id,
       email,
       first_name,
       last_name,
       username,
       contact_name,
       role
     FROM (
       SELECT
         dm.id::text AS row_id,
         COALESCE(
           NULLIF(trim(u.email), ''),
           NULLIF(trim(c.email), ''),
           CASE
             WHEN trim(dm.contact_member_id) LIKE '%@%' THEN lower(trim(dm.contact_member_id))
           END
         ) AS email,
         u.first_name,
         u.last_name,
         u.username,
         trim(concat_ws(' ', c.first_name, c.last_name)) AS contact_name,
         trim(dm.deal_member_role) AS role
       FROM deal_member dm
       LEFT JOIN users u ON trim(dm.contact_member_id) = u.id::text
       LEFT JOIN contact c ON c.id::text = trim(both from dm.contact_member_id)
       WHERE dm.deal_id = $1::uuid
         AND lower(trim(dm.deal_member_role)) IN ${SPONSOR_MEMBER_ROLES_SQL}

       UNION ALL

       SELECT
         di.id::text AS row_id,
         COALESCE(
           NULLIF(trim(u.email), ''),
           NULLIF(trim(c.email), ''),
           CASE
             WHEN trim(di.contact_id) LIKE '%@%' THEN lower(trim(di.contact_id))
           END
         ) AS email,
         u.first_name,
         u.last_name,
         u.username,
         trim(concat_ws(' ', c.first_name, c.last_name)) AS contact_name,
         trim(di.investor_role) AS role
       FROM deal_investment di
       LEFT JOIN users u ON trim(di.contact_id) = u.id::text
       LEFT JOIN contact c ON c.id::text = trim(di.contact_id)
       WHERE di.deal_id = $1::uuid
         AND trim(di.contact_id) <> '__portal_investment_autosave__'
         AND lower(trim(di.investor_role)) IN ${SPONSOR_MEMBER_ROLES_SQL}
     ) sponsors
     WHERE email IS NOT NULL AND trim(email) <> ''
     ORDER BY role, email`,
    [d],
  );

  const seen = new Set<string>();
  const out: DealMemberSignerOption[] = [];
  for (const row of res.rows) {
    const email = row.email?.trim().toLowerCase() ?? "";
    if (!email.includes("@")) continue;
    const dedupe = `${row.row_id}::${email}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      rowId: row.row_id,
      name: formatSignerName({ ...row, email }),
      email,
      role: row.role?.trim() || "Sponsor",
    });
  }
  return out;
}

export async function resolveDealMemberSignerByRowId(
  dealId: string,
  rowId: string,
): Promise<DealSponsorSigner | null> {
  const d = String(dealId ?? "").trim();
  const rid = String(rowId ?? "").trim();
  if (!d || !rid) return null;

  const res = await pool.query<{
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    contact_name: string | null;
  }>(
    `SELECT email, first_name, last_name, username, contact_name
     FROM (
       SELECT
         COALESCE(
           NULLIF(trim(u.email), ''),
           NULLIF(trim(c.email), ''),
           CASE
             WHEN trim(dm.contact_member_id) LIKE '%@%' THEN lower(trim(dm.contact_member_id))
           END
         ) AS email,
         u.first_name,
         u.last_name,
         u.username,
         trim(concat_ws(' ', c.first_name, c.last_name)) AS contact_name
       FROM deal_member dm
       LEFT JOIN users u ON trim(dm.contact_member_id) = u.id::text
       LEFT JOIN contact c ON c.id::text = trim(both from dm.contact_member_id)
       WHERE dm.deal_id = $1::uuid
         AND dm.id::text = $2
         AND lower(trim(dm.deal_member_role)) IN ${SPONSOR_MEMBER_ROLES_SQL}

       UNION ALL

       SELECT
         COALESCE(
           NULLIF(trim(u.email), ''),
           NULLIF(trim(c.email), ''),
           CASE
             WHEN trim(di.contact_id) LIKE '%@%' THEN lower(trim(di.contact_id))
           END
         ) AS email,
         u.first_name,
         u.last_name,
         u.username,
         trim(concat_ws(' ', c.first_name, c.last_name)) AS contact_name
       FROM deal_investment di
       LEFT JOIN users u ON trim(di.contact_id) = u.id::text
       LEFT JOIN contact c ON c.id::text = trim(di.contact_id)
       WHERE di.deal_id = $1::uuid
         AND di.id::text = $2
         AND trim(di.contact_id) <> '__portal_investment_autosave__'
         AND lower(trim(di.investor_role)) IN ${SPONSOR_MEMBER_ROLES_SQL}
     ) sponsors
     LIMIT 1`,
    [d, rid],
  );

  const row = res.rows[0];
  const email = row?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  return {
    email,
    name: formatSignerName({ ...row, email }),
  };
}

export type AssignSponsorSignerResult =
  | "ok"
  | "already_signed"
  | "assigned_to_other"
  | "missing";

/**
 * Claims unsigned "Anyone can sign" sponsor slots for this sponsor.
 * The slot stays open until that sponsor actually signs, so another sponsor
 * can still take it. A slot assigned to a named sponsor stays with that person.
 */
export async function assignSignFlowDocumentSponsorSigner(
  documentId: string,
  signer: DealSponsorSigner,
): Promise<AssignSponsorSignerResult> {
  const sigId = documentId.trim();
  if (!sigId) return "missing";
  const doc = await getSignFlowDocument(sigId);
  const recipients = [...(doc.recipients ?? [])];
  if (recipients.length === 0) return "missing";

  const email = signer.email.trim().toLowerCase();
  const name = signer.name.trim() || email;
  const sellers = recipients.filter((recipient) => {
    const role = String(recipient.role ?? "").trim().toLowerCase();
    return role === "seller" || role.includes("sponsor");
  });
  if (sellers.length === 0) return "missing";

  const unsignedOpen = sellers.filter(
    (recipient) =>
      isSignFlowOpenSponsorRecipient(recipient) &&
      !signFlowRecipientHasSigned(recipient),
  );
  const unsignedNamedMine = sellers.filter((recipient) => {
    if (isSignFlowOpenSponsorRecipient(recipient)) return false;
    if (signFlowRecipientHasSigned(recipient)) return false;
    return String(recipient.email ?? "").trim().toLowerCase() === email;
  });
  if (unsignedOpen.length === 0 && unsignedNamedMine.length === 0) {
    const unsignedNamedOther = sellers.some((recipient) => {
      if (isSignFlowOpenSponsorRecipient(recipient)) return false;
      if (signFlowRecipientHasSigned(recipient)) return false;
      const recipientEmail = String(recipient.email ?? "").trim().toLowerCase();
      return recipientEmail.includes("@") && recipientEmail !== email;
    });
    return unsignedNamedOther ? "assigned_to_other" : "already_signed";
  }

  let changed = false;
  const nextRecipients = recipients.map((recipient) => {
    if (!unsignedOpen.includes(recipient)) return recipient;
    const currentEmail = String(recipient.email ?? "").trim().toLowerCase();
    const currentName = String(recipient.name ?? "").trim();
    const markedName = signFlowOpenSponsorSignerName(name);
    if (currentEmail === email && currentName === markedName) {
      return recipient;
    }
    changed = true;
    return {
      ...recipient,
      email,
      name: markedName,
    };
  });
  if (!changed) return "ok";

  await patchSignFlowDocument(sigId, { recipients: nextRecipients });
  return "ok";
}

function openSponsorSlotFinished(recipient: {
  signed?: boolean;
  signingStatus?: string;
  status?: string;
  signedAt?: string | null;
}): boolean {
  if (signFlowRecipientHasSigned(recipient)) return true;
  const status = String(recipient.signingStatus ?? recipient.status ?? "")
    .trim()
    .toLowerCase();
  return status === "awaiting_countersign" && Boolean(recipient.signedAt?.trim());
}

/**
 * After an open sponsor slot is signed, store the sponsor who signed it.
 * SignFlow otherwise keeps the recipient as “Anyone can sign”.
 */
export async function stampCompletedOpenSponsorSigner(
  documentId: string,
  signer: DealSponsorSigner,
): Promise<void> {
  const sigId = documentId.trim();
  const email = signer.email.trim().toLowerCase();
  const name = signer.name.replace(/\u2060/g, "").trim();
  if (!sigId || !email.includes("@") || !name) return;
  const doc = await getSignFlowDocument(sigId);
  let changed = false;
  const nextRecipients = (doc.recipients ?? []).map((recipient) => {
    if (!isSignFlowOpenSponsorRecipient(recipient)) return recipient;
    if (!openSponsorSlotFinished(recipient)) return recipient;
    const currentName = String(recipient.name ?? "")
      .replace(/\u2060/g, "")
      .trim();
    const currentEmail = String(recipient.email ?? "").trim().toLowerCase();
    if (currentName === name && currentEmail === email) return recipient;
    const lower = currentName.toLowerCase();
    const stillPlaceholder =
      !currentName ||
      lower.includes("anyone can sign") ||
      lower === "any sponsor" ||
      lower === "sponsor" ||
      currentEmail.endsWith("@embed.local") ||
      !currentEmail.includes("@");
    if (!stillPlaceholder && currentName.toLowerCase() !== name.toLowerCase()) {
      return recipient;
    }
    changed = true;
    return { ...recipient, email, name };
  });
  if (!changed) return;
  await patchSignFlowDocument(sigId, { recipients: nextRecipients });
}

const SPONSOR_RECIPIENT_COLORS = ["#2563eb", "#7c3aed", "#0f766e", "#b45309", "#be123c"];

function isPlaceholderSponsorEmail(email: string | null | undefined): boolean {
  const value = String(email ?? "").trim().toLowerCase();
  return !value.includes("@") || value.endsWith("@embed.local");
}

function sponsorRoleLabel(role: string): string {
  return role
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Adds each deal sponsor as their own sponsor signer on the template.
 * Fields placed for a sponsor stay on that sponsor instead of one shared signer.
 */
export async function syncDealSponsorsOntoSignFlowTemplate(
  documentId: string,
  dealId: string,
): Promise<void> {
  const sigId = documentId.trim();
  if (!sigId) return;
  const sponsors = await listDealSponsorSignerOptions(dealId);
  if (sponsors.length === 0) return;

  const doc = await getSignFlowDocument(sigId);
  let renamedOpenSponsor = false;
  const existing = [...(doc.recipients ?? [])].map((recipient) => {
    if (!isSignFlowOpenSponsorRecipient(recipient)) return recipient;
    const label = String(recipient.name ?? "").trim().toLowerCase();
    if (label === "sponsor" || !label) {
      renamedOpenSponsor = true;
      return { ...recipient, name: SIGNFLOW_OPEN_SPONSOR_NAME };
    }
    return recipient;
  });
  const knownEmails = new Set(
    existing
      .map((recipient) => String(recipient.email ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  let order = existing.reduce(
    (max, recipient) => Math.max(max, Number(recipient.order) || 0),
    2,
  );
  const next = [...existing];
  let added = false;

  sponsors.forEach((sponsor, index) => {
    const email = sponsor.email.trim().toLowerCase();
    if (!email.includes("@") || knownEmails.has(email)) return;
    knownEmails.add(email);
    order += 1;
    const roleLabel = sponsorRoleLabel(sponsor.role || "Sponsor");
    next.push({
      name: `${sponsor.name} (${roleLabel})`,
      email,
      role: "seller",
      color: SPONSOR_RECIPIENT_COLORS[(index + 1) % SPONSOR_RECIPIENT_COLORS.length],
      order,
    });
    added = true;
  });

  if (!added && !renamedOpenSponsor) return;
  await patchSignFlowDocument(sigId, { recipients: next });
}

export function isNamedSponsorRecipientEmail(email: string | null | undefined): boolean {
  return !isPlaceholderSponsorEmail(email);
}
