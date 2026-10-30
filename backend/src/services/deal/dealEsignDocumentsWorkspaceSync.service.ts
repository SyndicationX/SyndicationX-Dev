/**
 * When an investor completes eSign, mirror signed PDFs into the deal Documents tab
 * under a dedicated "Esign template" section (`offering_investor_preview_json.sections`).
 */

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { getUploadsPhysicalRoot } from "../../config/uploadPaths.js";
import {
  commitmentProfileDisplayLabel,
  esignSendReadyForSponsorCounterSign,
  parseEsignStatusBundle,
  type StoredDealInvestorEsignSend,
} from "../../constants/deal-investor-esign-status.js";
import { getActiveEsignProvider } from "../../config/esignProvider.config.js";
import { resolveEsignSignflowWorkflowType } from "../../constants/esignSigningWorkflow.js";
import {
  getSignFlowDocument,
  downloadSignFlowRecipientSignedPdfBuffer,
  downloadSignFlowSignedPdfBuffer,
  isSignFlowNotAllSignedError,
  resolveSignFlowSponsorRecipientId,
  signFlowSponsorSignsBeforeInvestor,
  signFlowInvestorPhaseComplete,
  signFlowPendingSponsorSignAudience,
  signFlowTemplateHasSponsorFields,
  type SignFlowDocument,
} from "../esign/signflow.service.js";
import { db } from "../../database/db.js";
import { dealInvestment } from "../../schema/deal.schema/deal-investment.schema.js";
import { dealLpInvestor } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import { formatDdMmmYyyy } from "../../utils/formatDdMmmYyyy.js";
import { sanitizeOfferingInvestorPreviewBody } from "../../utils/sanitizeOfferingInvestorPreviewJson.js";
import {
  getAddDealFormById,
  updateDealOfferingInvestorPreviewById,
} from "./dealForm.service.js";
import {
  listDealSponsorSignerOptions,
} from "./dealEsignSigningWorkflow.service.js";
import { sequentialWorkflowSponsorDocsGateOpen } from "./dealSequentialEsignWorkflow.service.js";
import {
  findEsignTemplateFile,
  getDealEsignTemplatesState,
  type EsignTemplatesJson,
} from "./dealEsignTemplates.service.js";
import { mapContactIdsToCanonicalCommitmentKeys } from "./dealInvestment.service.js";
import { updateDealInvestorEsignSend } from "./dealMemberEsignStatus.service.js";
import {
  DEAL_ESIGN_COMPLETED_FOLDER,
  dealAssetsRelativePath,
  resolveDealStorageFolderName,
  sanitizeStoragePathSegment,
} from "./dealStoragePaths.service.js";

export const ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID =
  "esign-template-documents-section";

export const ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL = "Investor e signatures";

const LEGACY_ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL = "Esign template";

function uploadPublicUrl(relativePath: string): string {
  const rel = relativePath.replace(/^\/+/, "").replace(/^uploads\//i, "");
  return rel ? `/uploads/${rel}` : "";
}

function sendHasStoredOrRecordedSignature(
  send: StoredDealInvestorEsignSend,
): boolean {
  if (send.completedAt?.trim() || send.signedAt?.trim()) return true;
  return (send.documents ?? []).some((d) => Boolean(d.signedRelativePath?.trim()));
}

function listSignedEsignDocumentsForSend(
  send: StoredDealInvestorEsignSend,
  signatureRequestId: string,
  opts?: { preferFullSignedCopy?: boolean },
): Array<{ fileId: string; name: string; url: string | null }> {
  if (!sendHasStoredOrRecordedSignature(send)) return [];
  const docs = send.documents ?? [];
  if (docs.length === 0) return [];

  const investorPath =
    docs.find((d) => d.signedRelativePath?.trim())?.signedRelativePath?.trim() ??
    "";
  const fullPath = send.fullSignedRelativePath?.trim() ?? "";
  const sharedPath =
    opts?.preferFullSignedCopy && fullPath ? fullPath : investorPath;
  const sharedUrl = sharedPath ? uploadPublicUrl(sharedPath) : null;
  const sig = signatureRequestId.trim();

  return docs.map((d) => {
    const rel =
      (opts?.preferFullSignedCopy && fullPath ? fullPath : "") ||
      d.signedRelativePath?.trim() ||
      sharedPath;
    const url = rel ? uploadPublicUrl(rel) : sharedUrl;
    const compositeId = sig && d.fileId ? `${sig}::${d.fileId}` : d.fileId;
    return {
      fileId: compositeId,
      name: d.name,
      url: url || null,
    };
  });
}

/** Sent packet the sponsor can open before the investor signs (template preview). */
function listPendingEsignDocumentsForSponsor(
  send: StoredDealInvestorEsignSend,
  signatureRequestId: string,
): Array<{ fileId: string; name: string; url: string | null }> {
  const sig = signatureRequestId.trim();
  const docs = send.documents ?? [];
  if (docs.length === 0) {
    if (!sig) return [];
    return [{ fileId: sig, name: "eSign document", url: null }];
  }
  return docs.map((d) => {
    const sponsorPath = send.sponsorSignedRelativePath?.trim() ?? "";
    const fullPath = send.fullSignedRelativePath?.trim() ?? "";
    const templatePath = d.templateRelativePath?.trim() ?? "";
    const viewPath = sponsorPath || fullPath || templatePath;
    const compositeId = sig && d.fileId ? `${sig}::${d.fileId}` : d.fileId || sig;
    return {
      fileId: compositeId,
      name: d.name?.trim() || "eSign document",
      url: viewPath ? uploadPublicUrl(viewPath) : null,
    };
  });
}

async function writeStoredEsignPdf(params: {
  dealId: string;
  rosterId: string;
  filePrefix: string;
  buffer: Buffer;
}): Promise<string> {
  const dealFolder = await resolveDealStorageFolderName(params.dealId);
  const rosterFolder =
    sanitizeStoragePathSegment(params.rosterId, 64) || "investor";
  const relativePath = dealAssetsRelativePath(
    dealFolder,
    DEAL_ESIGN_COMPLETED_FOLDER,
    rosterFolder,
    `${params.filePrefix}-${Date.now()}.pdf`,
  );
  const abs = path.join(getUploadsPhysicalRoot(), relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, params.buffer);
  return relativePath;
}

/**
 * After the sponsor signs, Documents → View must open that signed PDF.
 * Before the investor signs, that is the sponsor copy. Once both have signed,
 * it is the fully executed PDF.
 */
async function ensureSponsorSignedPdfForDocumentsView(params: {
  dealId: string;
  rosterId: string;
  investorRowTable: "investment" | "lp";
  signatureRequestId: string;
  send: StoredDealInvestorEsignSend;
  investorPacketReady: boolean;
}): Promise<StoredDealInvestorEsignSend> {
  const existingFull = params.send.fullSignedRelativePath?.trim() ?? "";
  if (existingFull && params.investorPacketReady) return params.send;
  const existingSponsor = params.send.sponsorSignedRelativePath?.trim() ?? "";
  if (existingSponsor && !params.investorPacketReady) return params.send;

  const target = {
    table: params.investorRowTable,
    id: params.rosterId,
  };

  if (params.investorPacketReady && !existingFull) {
    try {
      const buffer = await downloadSignFlowSignedPdfBuffer(
        params.signatureRequestId,
      );
      const fullSignedRelativePath = await writeStoredEsignPdf({
        dealId: params.dealId,
        rosterId: params.rosterId,
        filePrefix: "signed-full",
        buffer,
      });
      await updateDealInvestorEsignSend(
        params.dealId,
        target,
        params.signatureRequestId,
        (current) => ({ ...current, fullSignedRelativePath }),
      );
      return { ...params.send, fullSignedRelativePath };
    } catch (err) {
      if (!isSignFlowNotAllSignedError(err)) {
        console.warn("ensureSponsorSignedPdfForDocumentsView (full):", err);
      }
    }
  }

  if (existingSponsor) return params.send;

  try {
    const doc = await getSignFlowDocument(params.signatureRequestId);
    const sponsorId = resolveSignFlowSponsorRecipientId(doc);
    const buffer = await downloadSignFlowRecipientSignedPdfBuffer(
      params.signatureRequestId,
      sponsorId,
    );
    const sponsorSignedRelativePath = await writeStoredEsignPdf({
      dealId: params.dealId,
      rosterId: params.rosterId,
      filePrefix: "signed-sponsor",
      buffer,
    });
    await updateDealInvestorEsignSend(
      params.dealId,
      target,
      params.signatureRequestId,
      (current) => ({ ...current, sponsorSignedRelativePath }),
    );
    return { ...params.send, sponsorSignedRelativePath };
  } catch (err) {
    console.warn("ensureSponsorSignedPdfForDocumentsView (sponsor):", err);
    return params.send;
  }
}

type PreviewParts = {
  visibility: Record<string, boolean>;
  sections: Record<string, unknown>[];
};

function readPreviewParts(raw: string | null | undefined): PreviewParts {
  if (!raw?.trim()) return { visibility: {}, sections: [] };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const visibility =
      parsed.visibility != null &&
      typeof parsed.visibility === "object" &&
      !Array.isArray(parsed.visibility)
        ? (parsed.visibility as Record<string, boolean>)
        : {};
    const sections = Array.isArray(parsed.sections)
      ? (parsed.sections as Record<string, unknown>[])
      : [];
    return { visibility, sections };
  } catch {
    return { visibility: {}, sections: [] };
  }
}

function isInvestorEsignNestedDocument(doc: Record<string, unknown>): boolean {
  if (String(doc.esignSignatureRequestId ?? "").trim()) return true;
  if (String(doc.esignInvestorRowId ?? "").trim()) return true;
  if (String(doc.esignTemplateFileId ?? "").trim()) return true;
  const lpSectionId = String(doc.lpDisplaySectionId ?? "").trim();
  if (!lpSectionId) return false;
  if (lpSectionId === ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID) return true;
  return lpSectionId.toLowerCase().startsWith("recovered-investor-e-signature");
}

/** Remove investor eSign PDFs from non–e-sign sections (and drop duplicate e-sign section rows). */
export function stripInvestorEsignDocumentsFromOtherSections(
  sections: Record<string, unknown>[],
): Record<string, unknown>[] {
  return sections
    .filter((s) => !isEsignTemplateSection(s))
    .map((s) => {
      const nested = Array.isArray(s.nestedDocuments) ? s.nestedDocuments : [];
      return {
        ...s,
        nestedDocuments: nested.filter((raw) => {
          if (raw == null || typeof raw !== "object") return true;
          const doc = raw as Record<string, unknown>;
          if (String(doc.id ?? "").trim().startsWith("esign-promoted-")) {
            return false;
          }
          return !isInvestorEsignNestedDocument(doc);
        }),
      };
    });
}

/** Move misplaced investor eSign PDFs into the canonical Investor e signatures section. */
export function consolidateInvestorEsignDocumentSections(
  sections: Record<string, unknown>[],
): Record<string, unknown>[] {
  const esignDocsById = new Map<string, Record<string, unknown>>();
  for (const section of sections) {
    const nested = Array.isArray(section.nestedDocuments)
      ? section.nestedDocuments
      : [];
    for (const raw of nested) {
      if (raw == null || typeof raw !== "object") continue;
      const doc = raw as Record<string, unknown>;
      if (!isInvestorEsignNestedDocument(doc)) continue;
      const id = String(doc.id ?? "").trim();
      if (!id) continue;
      esignDocsById.set(id, {
        ...doc,
        lpDisplaySectionId: ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID,
      });
    }
  }

  const stripped = stripInvestorEsignDocumentsFromOtherSections(sections);
  if (esignDocsById.size === 0) return stripped;

  const prior = sections.find(
    (s) => String(s.id ?? "").trim() === ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID,
  );
  stripped.push({
    ...(prior ?? {
      id: ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID,
      sectionLabel: ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL,
      documentLabel: ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL,
      visibility: "Sponsor workspace only",
      sharedWithScope: "not_visible",
      requireLpReview: false,
      dateAdded: formatDdMmmYyyy(new Date()),
    }),
    nestedDocuments: [...esignDocsById.values()],
  });
  return stripped;
}

const ESIGN_STORAGE_URL = /\/e-signed(?:-completed|-preview)?\//i;

function nestedDocHiddenFromPublicOffering(
  doc: Record<string, unknown>,
): boolean {
  if (isInvestorEsignNestedDocument(doc)) return true;
  const id = String(doc.id ?? "").trim();
  if (id.startsWith("esign-promoted-")) return true;
  const url = String(doc.url ?? "").trim();
  return Boolean(url) && ESIGN_STORAGE_URL.test(url);
}

/**
 * Shared offering preview must not include eSign templates or signed packets.
 * Signed copies stay on the investor's own documents when Shared With that investor.
 */
export function stripEsignDocumentsFromPublicOfferingPreview(
  json: string | null | undefined,
): string | null {
  if (!json?.trim()) return json ?? null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const { visibility, sections } = readPreviewParts(json);
    const nextSections = sections
      .filter((section) => !isEsignTemplateSection(section))
      .map((section) => {
        const nested = Array.isArray(section.nestedDocuments)
          ? section.nestedDocuments
          : [];
        return {
          ...section,
          nestedDocuments: nested.filter((raw) => {
            if (raw == null || typeof raw !== "object") return true;
            return !nestedDocHiddenFromPublicOffering(
              raw as Record<string, unknown>,
            );
          }),
        };
      });
    return sanitizeOfferingInvestorPreviewBody({
      visibility: parsed.visibility ?? visibility,
      sections: nextSections,
    });
  } catch {
    return json;
  }
}

function isEsignTemplateSection(section: Record<string, unknown>): boolean {
  const id = String(section.id ?? "").trim();
  if (id === ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID) return true;
  const idLower = id.toLowerCase();
  if (idLower.startsWith("recovered-investor-e-signature")) return true;
  const label = String(section.sectionLabel ?? section.label ?? "")
    .trim()
    .toLowerCase();
  return (
    label === ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL.toLowerCase() ||
    label === LEGACY_ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL.toLowerCase()
  );
}

const NO_PENDING_SPONSOR_AUDIENCE = {
  openToAnySponsor: false,
  pendingNamedSponsorEmails: [] as string[],
};

const NO_SIGNED_PARTIES = {
  signedBy: [] as string[],
  investorSignedNames: [] as string[],
  sponsorSignedNames: [] as string[],
  sponsorSignedEmails: [] as string[],
  investorSignerNamed: false,
  investorCompleted: false,
  sponsorCompleted: false,
  signersLoaded: false,
};

function isInvestorSignFlowRecipient(recipient: {
  id?: string;
  role?: string;
}): boolean {
  const role = String(recipient.role ?? "").trim().toLowerCase();
  const id = String(recipient.id ?? "").trim().toLowerCase();
  return (
    role.includes("investor") ||
    role.includes("buyer") ||
    id === "rec_investor" ||
    id === "rec_1"
  );
}

function isGenericSignerLabel(name: string): boolean {
  const lower = name.replace(/\u2060/g, "").trim().toLowerCase();
  return (
    !lower ||
    lower.includes("anyone can sign") ||
    lower === "any sponsor" ||
    lower === "sponsor" ||
    lower === "investor" ||
    lower === "buyer" ||
    lower === "seller" ||
    lower.endsWith("@embed.local")
  );
}

/** Real person name or email. Placeholder roles such as "Anyone can sign" are omitted. */
function usableSignedPartyLabel(recipient: {
  name?: string;
  email?: string;
}): string | null {
  const name = String(recipient.name ?? "")
    .replace(/\u2060/g, "")
    .trim();
  if (name && !isGenericSignerLabel(name)) return name;
  const email = String(recipient.email ?? "").trim();
  if (email.includes("@") && !isGenericSignerLabel(email)) return email;
  return null;
}

/** Typed signature text is the name the person signed. Drawn marks are images. */
function personNameFromFieldValue(raw: string): string | null {
  let value = raw.replace(/\u2060/g, "").trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (
    lower.startsWith("drawn:") ||
    lower.startsWith("data:") ||
    lower.startsWith("http")
  ) {
    return null;
  }
  if (lower.startsWith("typed:")) value = value.slice("typed:".length).trim();
  if (!value || value.length > 80) return null;
  return usableSignedPartyLabel({ name: value });
}

function isSponsorSignFlowRecipient(recipient: {
  id?: string;
  role?: string;
}): boolean {
  const role = String(recipient.role ?? "").trim().toLowerCase();
  const id = String(recipient.id ?? "").trim().toLowerCase();
  return (
    role.includes("sponsor") ||
    role.includes("seller") ||
    role === "open-sponsor" ||
    id === "rec_sponsor" ||
    id === "rec_sponsor_open" ||
    id === "rec_2"
  );
}

/** Completed signature only. A viewed recipient can still carry signedAt. */
function recipientSigningCompleted(recipient: {
  signed?: boolean;
  signingStatus?: string;
  status?: string;
  signedAt?: string;
}): boolean {
  if (recipient.signed === true) return true;
  const status = String(recipient.signingStatus ?? recipient.status ?? "")
    .trim()
    .toLowerCase();
  if (status === "signed" || status === "completed") return true;
  // Sponsor finished their own session; SignFlow may still say awaiting countersign.
  return status === "awaiting_countersign" && Boolean(recipient.signedAt?.trim());
}

function inkedSignerName(
  doc: SignFlowDocument,
  recipientId: string | undefined,
): string | null {
  const id = recipientId?.trim();
  if (!id) return null;
  for (const field of doc.fields ?? []) {
    if (String(field.recipientId ?? "").trim() !== id) continue;
    const type = String(field.type ?? "").trim().toLowerCase();
    if (type !== "signature" && type !== "name") continue;
    const name = personNameFromFieldValue(String(field.value ?? ""));
    if (name) return name;
  }
  return null;
}

function sameSignerName(left: string, right: string): boolean {
  const a = left.replace(/\u2060/g, "").trim().toLowerCase();
  const b = right.replace(/\u2060/g, "").trim().toLowerCase();
  return Boolean(a) && a === b;
}

function collectSignedPartyNames(
  doc: SignFlowDocument,
  assumeComplete: boolean,
): {
  signedBy: string[];
  investorSignedNames: string[];
  sponsorSignedNames: string[];
  sponsorSignedEmails: string[];
  investorSignerNamed: boolean;
  investorCompleted: boolean;
  sponsorCompleted: boolean;
  signersLoaded: boolean;
} {
  const investorSignedNames: string[] = [];
  const sponsorSignedNames: string[] = [];
  const sponsorSignedEmails: string[] = [];
  let investorSignerNamed = false;
  let investorCompleted = false;
  let sponsorCompleted = false;
  for (const recipient of doc.recipients ?? []) {
    const investor = isInvestorSignFlowRecipient(recipient);
    const sponsor = isSponsorSignFlowRecipient(recipient) && !investor;
    if (!investor && !sponsor) continue;
    const completed = assumeComplete || recipientSigningCompleted(recipient);
    if (!completed) continue;
    const label =
      usableSignedPartyLabel(recipient) ??
      inkedSignerName(doc, recipient.id);
    if (investor) {
      investorCompleted = true;
      if (label) {
        investorSignedNames.push(label);
        investorSignerNamed = true;
      }
    }
    if (sponsor) {
      sponsorCompleted = true;
      const email = String(recipient.email ?? "").trim();
      if (email.includes("@") && !isGenericSignerLabel(email)) {
        sponsorSignedEmails.push(email);
      }
      const inked = inkedSignerName(doc, recipient.id);
      const sponsorLabel = [inked, label].find(
        (name) =>
          Boolean(name) &&
          !investorSignedNames.some((investorName) =>
            sameSignerName(investorName, name ?? ""),
          ),
      );
      if (sponsorLabel) sponsorSignedNames.push(sponsorLabel);
    }
  }
  const signedBy = [...investorSignedNames, ...sponsorSignedNames].filter(
    (name, index, all) =>
      all.findIndex((item) => item.toLowerCase() === name.toLowerCase()) === index,
  );
  return {
    signedBy: signedBy.slice(0, 8),
    investorSignedNames,
    sponsorSignedNames,
    sponsorSignedEmails,
    investorSignerNamed,
    investorCompleted,
    sponsorCompleted,
    signersLoaded: true,
  };
}

export async function resolveEsignSponsorSignState(
  send: StoredDealInvestorEsignSend,
): Promise<{
  awaitingSponsorSignature: boolean;
  sponsorSigned: boolean;
  /** Parallel, or sequential sponsor-first: sponsor may sign before the investor. */
  sponsorMaySignBeforeInvestor: boolean;
  /** Unsigned generic Sponsor slot — every deal sponsor may sign. */
  openToAnySponsor: boolean;
  /** Unsigned slots assigned to specific sponsors. */
  pendingNamedSponsorEmails: string[];
  /** People who have finished signing, in recipient order. */
  signedBy: string[];
  investorSignedNames: string[];
  sponsorSignedNames: string[];
  sponsorSignedEmails: string[];
  /** True when the completed investor signer was stored under a real name or email. */
  investorSignerNamed: boolean;
  /** Investor recipient has finished signing on the live document. */
  investorCompleted: boolean;
  /** Sponsor recipient has finished signing on the live document. */
  sponsorCompleted: boolean;
  /** Live signer list was loaded. */
  signersLoaded: boolean;
}> {
  const investorSignedLocal = esignSendReadyForSponsorCounterSign(send);
  const fullyCompleted = Boolean(send.completedAt?.trim());
  const sigId = send.signatureRequestId?.trim();
  let doc: SignFlowDocument | null = null;
  let signedParties = NO_SIGNED_PARTIES;
  if (sigId && getActiveEsignProvider() === "signflow") {
    try {
      doc = await getSignFlowDocument(sigId);
      signedParties = collectSignedPartyNames(doc, fullyCompleted);
    } catch {
      doc = null;
    }
  }

  if (fullyCompleted) {
    return {
      awaitingSponsorSignature: false,
      sponsorSigned: true,
      sponsorMaySignBeforeInvestor: false,
      ...NO_PENDING_SPONSOR_AUDIENCE,
      ...signedParties,
    };
  }

  if (!doc) {
    if (!investorSignedLocal) {
      return {
        awaitingSponsorSignature: false,
        sponsorSigned: fullyCompleted,
        sponsorMaySignBeforeInvestor: false,
        ...NO_PENDING_SPONSOR_AUDIENCE,
        ...signedParties,
      };
    }
    return {
      awaitingSponsorSignature: !fullyCompleted,
      sponsorSigned: fullyCompleted,
      sponsorMaySignBeforeInvestor: false,
      ...NO_PENDING_SPONSOR_AUDIENCE,
      ...signedParties,
    };
  }

  try {
    const workflowType = String(doc.workflowType ?? "")
      .trim()
      .toLowerCase();
    const sponsorRecipient = (doc.recipients ?? []).find((recipient) => {
      const role = String(recipient.role ?? "").trim().toLowerCase();
      const id = String(recipient.id ?? "").trim().toLowerCase();
      return (
        role.includes("sponsor") ||
        role.includes("seller") ||
        id === "rec_sponsor" ||
        id === "rec_2"
      );
    });
    const investorOrders = (doc.recipients ?? [])
      .filter((recipient) => {
        const role = String(recipient.role ?? "").trim().toLowerCase();
        const id = String(recipient.id ?? "").trim().toLowerCase();
        return (
          role.includes("investor") ||
          role.includes("buyer") ||
          id === "rec_investor" ||
          id === "rec_1"
        );
      })
      .map((recipient) => Number(recipient.order) || 1);
    const sponsorOrder = Number(sponsorRecipient?.order) || 0;
    const sameSigningTurn =
      investorOrders.length > 0 &&
      sponsorOrder > 0 &&
      investorOrders.every((order) => order === sponsorOrder);
    const sponsorMaySignBeforeInvestor =
      workflowType === "parallel" ||
      sameSigningTurn ||
      signFlowSponsorSignsBeforeInvestor(doc);
    const audience = signFlowPendingSponsorSignAudience(doc);
    if (!signFlowTemplateHasSponsorFields(doc) || audience.allSponsorSlotsSigned) {
      return {
        awaitingSponsorSignature: false,
        sponsorSigned: true,
        sponsorMaySignBeforeInvestor: false,
        ...NO_PENDING_SPONSOR_AUDIENCE,
        ...signedParties,
      };
    }

    const investorSignedLive =
      investorSignedLocal || signFlowInvestorPhaseComplete(doc);
    const stillWaitingForInvestor =
      !sponsorMaySignBeforeInvestor && !investorSignedLive;

    return {
      awaitingSponsorSignature: !stillWaitingForInvestor,
      sponsorSigned: false,
      sponsorMaySignBeforeInvestor,
      openToAnySponsor: audience.openToAnySponsor,
      pendingNamedSponsorEmails: audience.namedEmails,
      ...signedParties,
    };
  } catch {
    if (!investorSignedLocal) {
      return {
        awaitingSponsorSignature: false,
        sponsorSigned: fullyCompleted,
        sponsorMaySignBeforeInvestor: false,
        ...NO_PENDING_SPONSOR_AUDIENCE,
        ...signedParties,
      };
    }
    return {
      awaitingSponsorSignature: !fullyCompleted,
      sponsorSigned: fullyCompleted,
      sponsorMaySignBeforeInvestor: false,
      ...NO_PENDING_SPONSOR_AUDIENCE,
      ...signedParties,
    };
  }
}

function sendReadyForInvestorEsignDocumentsSection(
  send: StoredDealInvestorEsignSend,
): boolean {
  return esignSendReadyForSponsorCounterSign(send);
}

/** Deal template is parallel, so the sponsor may open this sent copy before the investor. */
function sendTemplateIsParallel(
  send: StoredDealInvestorEsignSend,
  templates: EsignTemplatesJson | null,
): boolean {
  if (!templates) return false;
  for (const doc of send.documents ?? []) {
    const fileId = doc.fileId?.trim();
    if (!fileId) continue;
    const file = findEsignTemplateFile(templates, fileId);
    if (!file) continue;
    if (resolveEsignSignflowWorkflowType(file) === "parallel") return true;
  }
  return false;
}

function buildEsignNestedDocument(params: {
  docId: string;
  displayName: string;
  url: string;
  dateAdded: string;
  investorRowId: string;
  investorRowTable: "investment" | "lp";
  signatureRequestId: string;
  templateFileId: string;
  awaitingSponsorSignature: boolean;
  sponsorSigned: boolean;
  openToAnySponsor: boolean;
  pendingNamedSponsorEmails: string[];
  investorMatchIds: string[];
  investorName: string;
  investorProfile: string;
  signedByInvestor: string;
  signedBySponsor: string;
}): Record<string, unknown> {
  const investorName = params.investorName.trim();
  const investorProfile = params.investorProfile.trim();
  const investorMatchIds = [
    ...new Set(
      params.investorMatchIds
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].slice(0, 24);
  return {
    id: params.docId,
    name: params.displayName,
    url: params.url,
    dateAdded: params.dateAdded,
    lpDisplaySectionId: ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID,
    sharedDealClassIds: [],
    sharedInvestorIds: [],
    sharedWithAllInvestors: false,
    sharedSponsorUserIds: [],
    sharedWithScope: "not_visible",
    requiresProfileInvestment: false,
    esignSignatureRequestId: params.signatureRequestId || undefined,
    esignInvestorRowId: params.investorRowId,
    ...(investorMatchIds.length > 0
      ? { esignInvestorMatchIds: investorMatchIds }
      : {}),
    ...(investorName && investorName !== "Investor" && investorName !== "—"
      ? { esignInvestorName: investorName }
      : {}),
    ...(investorProfile && investorProfile !== "—"
      ? { esignInvestorProfile: investorProfile }
      : {}),
    esignInvestorRowTable: params.investorRowTable,
    esignTemplateFileId: params.templateFileId || undefined,
    esignAwaitingSponsorSignature: params.awaitingSponsorSignature,
    esignSponsorSigned: params.sponsorSigned,
    ...(params.openToAnySponsor ? { esignOpenSponsorSign: true } : {}),
    ...(params.pendingNamedSponsorEmails.length > 0
      ? { esignSponsorSignerEmails: params.pendingNamedSponsorEmails }
      : {}),
    ...(params.signedByInvestor
      ? { esignSignedByInvestor: params.signedByInvestor }
      : {}),
    ...(params.signedBySponsor
      ? { esignSignedBySponsor: params.signedBySponsor }
      : {}),
    ...((params.signedByInvestor || params.signedBySponsor)
      ? {
          esignSignedBy: [params.signedByInvestor, params.signedBySponsor].filter(
            Boolean,
          ),
        }
      : {}),
  };
}

function displayNameFromSignerLabels(
  liveNames: string[],
  rosterName: string,
  namesByEmail: Map<string, string>,
): string | null {
  const mapped = liveNames
    .map((name) => {
      const label = String(name ?? "").trim()
      return namesByEmail.get(label.toLowerCase()) || label
    })
    .filter(Boolean);
  const person = mapped.find(
    (name) => !name.includes("@") && !isGenericSignerLabel(name),
  );
  if (person) return person;
  const roster = rosterName.replace(/\u2060/g, "").trim();
  const rosterDisplay = namesByEmail.get(roster.toLowerCase()) || roster;
  if (
    rosterDisplay &&
    rosterDisplay !== "—" &&
    !isGenericSignerLabel(rosterDisplay) &&
    !rosterDisplay.includes("@")
  ) {
    return rosterDisplay;
  }
  return mapped.find((name) => name.includes("@")) ?? (roster && roster !== "—" ? roster : null);
}

function usablePartyName(value: unknown): string {
  const name = String(value ?? "").replace(/\u2060/g, "").trim();
  if (!name || name === "—" || isGenericSignerLabel(name)) return "";
  return name;
}

function rememberedSignerNames(doc: Record<string, unknown> | undefined): {
  investor: string;
  sponsor: string;
} {
  if (!doc) return { investor: "", sponsor: "" };
  const investorField = usablePartyName(doc.esignSignedByInvestor);
  const sponsorField = usablePartyName(doc.esignSignedBySponsor);
  if (investorField || sponsorField) {
    return { investor: investorField, sponsor: sponsorField };
  }
  const names = Array.isArray(doc.esignSignedBy)
    ? doc.esignSignedBy.map((value) => usablePartyName(value)).filter(Boolean)
    : [];
  const investorName = usablePartyName(doc.esignInvestorName);
  if (names.length >= 2) {
    return { investor: names[0] ?? "", sponsor: names[names.length - 1] ?? "" };
  }
  const only = names[0] ?? "";
  if (!only) return { investor: "", sponsor: "" };
  if (investorName && only.toLowerCase() === investorName.toLowerCase()) {
    return { investor: only, sponsor: "" };
  }
  if (doc.esignSponsorSigned === true) return { investor: "", sponsor: only };
  return { investor: only, sponsor: "" };
}

/** Removing an investor must not drop the sponsor who already signed. */
function mergeRememberedSignerNames(
  doc: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const current = rememberedSignerNames(doc);
  const earlier = rememberedSignerNames(previous);
  const sponsorSigned =
    doc.esignSponsorSigned === true || previous?.esignSponsorSigned === true;
  const investor = current.investor || earlier.investor;
  const earlierSponsor =
    sponsorSigned && earlier.sponsor && !sameSignerName(earlier.sponsor, investor)
      ? earlier.sponsor
      : "";
  const sponsor =
    current.sponsor && !sameSignerName(current.sponsor, investor)
      ? current.sponsor
      : earlierSponsor;
  const signedBy = [investor, sponsor].filter(Boolean);
  return {
    ...doc,
    ...(investor ? { esignSignedByInvestor: investor } : {}),
    ...(sponsor ? { esignSignedBySponsor: sponsor } : {}),
    ...(signedBy.length > 0 ? { esignSignedBy: signedBy } : {}),
  };
}

function uniqueSignerNames(values: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  for (const raw of values) {
    const name = String(raw ?? "").replace(/\u2060/g, "").trim();
    if (!name || name === "—" || isGenericSignerLabel(name)) continue;
    if (names.some((item) => item.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
  }
  return names.slice(0, 8);
}

function signedByForDocumentsColumn(params: {
  investorSignedNames: string[];
  sponsorSignedNames: string[];
  investorCompleted: boolean;
  sponsorCompleted: boolean;
  signersLoaded: boolean;
  investorLabel: string;
  /** Sponsor who signed the open slot, saved when they opened or finished signing. */
  recordedSponsorName: string;
  sponsorSignedEmails?: string[];
  /** Stored signed PDF or a fully completed send. Not a view or an in-progress session. */
  investorStoredComplete: boolean;
  sponsorSignedRelativePath?: string;
  fullSignedRelativePath?: string;
  fullyCompleted: boolean;
  sponsorNamesByEmail: Map<string, string>;
}): { investor: string; sponsor: string } {
  const investorDone = params.investorCompleted || params.investorStoredComplete;
  // Completed packets signed before this column existed still have completedAt
  // or a stored full PDF. An open SignFlow slot stays “Anyone can sign”; the
  // name shown is the sponsor who signed that slot.
  const sponsorDone =
    params.sponsorCompleted ||
    params.fullyCompleted ||
    Boolean(params.sponsorSignedRelativePath?.trim()) ||
    Boolean(params.fullSignedRelativePath?.trim());
  const investorRoster = String(params.investorLabel ?? "").replace(/\u2060/g, "").trim();
  const investorLive =
    displayNameFromSignerLabels(
      params.investorSignedNames,
      "",
      params.sponsorNamesByEmail,
    ) ?? "";
  const investor = investorDone
    ? !isGenericSignerLabel(investorRoster)
      ? investorRoster
      : investorLive
    : "";
  const recordedRaw = String(params.recordedSponsorName ?? "").replace(/\u2060/g, "").trim();
  const recordedSponsor = recordedRaw.includes("@")
    ? params.sponsorNamesByEmail.get(recordedRaw.toLowerCase()) || recordedRaw
    : recordedRaw;
  const sponsorFromEmail = (params.sponsorSignedEmails ?? [])
    .map((email) => params.sponsorNamesByEmail.get(email.trim().toLowerCase()) || "")
    .find((name) => name && !sameSignerName(name, investor));
  const sponsorFromLive = params.sponsorSignedNames.find(
    (name) => name && !sameSignerName(name, investor) && !isGenericSignerLabel(name),
  );
  const sponsorCandidate = [recordedSponsor, sponsorFromLive, sponsorFromEmail].find(
    (name) =>
      Boolean(name) &&
      !isGenericSignerLabel(name ?? "") &&
      !sameSignerName(name ?? "", investor),
  );
  const sponsor = sponsorDone ? sponsorCandidate ?? "" : "";
  return {
    investor: isGenericSignerLabel(investor) ? "" : investor,
    sponsor: isGenericSignerLabel(sponsor) ? "" : sponsor,
  };
}

async function collectCompletedEsignNestedDocuments(
  dealId: string,
  investorRowId: string,
  investorRowTable: "investment" | "lp",
  investorDisplayName: string,
  profileId: string | null | undefined,
  investorMatchIds: string[],
  esignStatusJson: string | null | undefined,
  sponsorDocsGateOpen: boolean,
  templates: EsignTemplatesJson | null,
  sponsorNamesByEmail: Map<string, string>,
): Promise<Record<string, unknown>[]> {
  const bundle = parseEsignStatusBundle(esignStatusJson);
  if (!bundle?.sends.length) return [];
  if (!sponsorDocsGateOpen) return [];

  const investorLabel = investorDisplayName.trim() || "Investor";
  const profileLabel = commitmentProfileDisplayLabel(profileId);
  const out: Record<string, unknown>[] = [];

  for (const send of bundle.sends) {
    const sig = send.signatureRequestId?.trim() ?? "";
    const sponsorState = await resolveEsignSponsorSignState(send);
    const investorPacketReady = sendReadyForInvestorEsignDocumentsSection(send);
    const parallelTemplate = sendTemplateIsParallel(send, templates);
    const sponsorCanOpenNow =
      sponsorState.sponsorMaySignBeforeInvestor ||
      (parallelTemplate && !sponsorState.sponsorSigned);
    if (!investorPacketReady && !sponsorCanOpenNow) {
      continue;
    }
    if (!investorPacketReady && !send.sentAt?.trim()) continue;
    let sendForView = send;
    if (
      sponsorState.sponsorSigned &&
      sig &&
      getActiveEsignProvider() === "signflow"
    ) {
      sendForView = await ensureSponsorSignedPdfForDocumentsView({
        dealId,
        rosterId: investorRowId,
        investorRowTable,
        signatureRequestId: sig,
        send,
        investorPacketReady,
      });
    }
    const signedDocs = investorPacketReady
      ? listSignedEsignDocumentsForSend(sendForView, sig, {
          preferFullSignedCopy: sponsorState.sponsorSigned,
        })
      : listPendingEsignDocumentsForSponsor(sendForView, sig);
    const completedAt =
      send.signedAt?.trim() ||
      send.completedAt?.trim() ||
      send.sentAt?.trim() ||
      "";
    const dateAdded = formatDdMmmYyyy(completedAt);

    for (const doc of signedDocs) {
      const url = doc.url?.trim() ?? "";
      if (!url && !sponsorCanOpenNow) continue;
      const docId = doc.fileId.trim();
      if (!docId) continue;
      const templateName = doc.name.trim() || "Signed document";
      const displayName = `${templateName} - ${investorLabel} - ${profileLabel}`;
      const templateFileId = docId.includes("::")
        ? docId.split("::").pop()?.trim() ?? docId
        : docId;
      const signedBy = signedByForDocumentsColumn({
        investorSignedNames: sponsorState.investorSignedNames,
        sponsorSignedNames: sponsorState.sponsorSignedNames,
        investorCompleted: sponsorState.investorCompleted,
        sponsorCompleted: sponsorState.sponsorCompleted,
        signersLoaded: sponsorState.signersLoaded,
        investorLabel,
        recordedSponsorName:
          send.sponsorSignedByName?.trim() ||
          send.sponsorSignedByEmail?.trim() ||
          "",
        sponsorSignedEmails: sponsorState.sponsorSignedEmails,
        investorStoredComplete:
          esignSendReadyForSponsorCounterSign(send) ||
          Boolean(send.completedAt?.trim()),
        sponsorSignedRelativePath: send.sponsorSignedRelativePath,
        fullSignedRelativePath: send.fullSignedRelativePath,
        fullyCompleted: Boolean(send.completedAt?.trim()),
        sponsorNamesByEmail,
      });
      out.push(
        buildEsignNestedDocument({
          docId,
          displayName,
          url,
          dateAdded,
          investorRowId,
          investorRowTable,
          signatureRequestId: sig,
          templateFileId,
          awaitingSponsorSignature:
            sponsorState.awaitingSponsorSignature ||
            (sponsorCanOpenNow && !sponsorState.sponsorSigned),
          sponsorSigned: sponsorState.sponsorSigned,
          openToAnySponsor: sponsorState.openToAnySponsor,
          pendingNamedSponsorEmails: sponsorState.pendingNamedSponsorEmails,
          investorMatchIds,
          investorName: investorLabel,
          investorProfile: profileLabel,
          signedByInvestor: signedBy.investor,
          signedBySponsor: signedBy.sponsor,
        }),
      );
    }
  }

  return out;
}

/**
 * Rebuild the Investor e signatures section from completed investor eSign rows.
 * Signed PDFs stay in that section and are not copied into General.
 * Returns true when `offering_investor_preview_json` was updated.
 */
export async function syncCompletedEsignDocumentsToDocumentsTab(
  dealId: string,
): Promise<boolean> {
  const id = dealId.trim();
  if (!id) return false;

  const deal = await getAddDealFormById(id);
  if (!deal) return false;

  const [investments, roster] = await Promise.all([
    db
      .select({
        id: dealInvestment.id,
        contactId: dealInvestment.contactId,
        contactDisplayName: dealInvestment.contactDisplayName,
        profileId: dealInvestment.profileId,
        userInvestorProfileId: dealInvestment.userInvestorProfileId,
        esignStatusJson: dealInvestment.esignStatusJson,
      })
      .from(dealInvestment)
      .where(eq(dealInvestment.dealId, id)),
    db
      .select({
        id: dealLpInvestor.id,
        investorName: dealLpInvestor.investorName,
        contactMemberId: dealLpInvestor.contactMemberId,
        email: dealLpInvestor.email,
        profileId: dealLpInvestor.profileId,
        userInvestorProfileId: dealLpInvestor.userInvestorProfileId,
        esignStatusJson: dealLpInvestor.esignStatusJson,
      })
      .from(dealLpInvestor)
      .where(eq(dealLpInvestor.dealId, id)),
  ]);

  const contactCanonicalKeys = await mapContactIdsToCanonicalCommitmentKeys([
    ...investments.flatMap((row) => [
      row.id,
      row.contactId,
      row.userInvestorProfileId,
    ]),
    ...roster.flatMap((row) => [
      row.id,
      row.contactMemberId,
      row.userInvestorProfileId,
    ]),
  ]);
  const canonOf = (raw: string | null | undefined): string => {
    const key = String(raw ?? "").trim().toLowerCase();
    if (!key) return "";
    return contactCanonicalKeys.get(key) ?? `id:${key}`;
  };
  const idsByCanon = new Map<string, Set<string>>();
  const remember = (
    canon: string,
    ...ids: Array<string | null | undefined>
  ) => {
    if (!canon) return;
    let bucket = idsByCanon.get(canon);
    if (!bucket) {
      bucket = new Set();
      idsByCanon.set(canon, bucket);
    }
    for (const raw of ids) {
      const value = String(raw ?? "").trim();
      if (value) bucket.add(value);
    }
  };
  for (const row of investments) {
    remember(
      canonOf(row.contactId) || canonOf(row.id),
      row.id,
      row.contactId,
      row.userInvestorProfileId,
    );
  }
  for (const row of roster) {
    remember(
      canonOf(row.contactMemberId) || canonOf(row.id),
      row.id,
      row.contactMemberId,
      row.userInvestorProfileId,
    );
  }
  const matchIdsFor = (
    contactRaw: string | null | undefined,
    rowId: string,
  ): string[] => {
    const canon = canonOf(contactRaw) || canonOf(rowId);
    return [...(idsByCanon.get(canon) ?? new Set<string>([rowId]))];
  };

  const sponsorDocsGateOpen = await sequentialWorkflowSponsorDocsGateOpen(id);
  const templates = await getDealEsignTemplatesState(id).catch(() => null);
  const sponsorNamesByEmail = new Map<string, string>();
  const sponsorOptions = await listDealSponsorSignerOptions(id).catch(() => []);
  for (const option of sponsorOptions) {
    const email = option.email.trim().toLowerCase();
    const name = option.name.trim();
    if (email && name) sponsorNamesByEmail.set(email, name);
  }
  const nestedById = new Map<string, Record<string, unknown>>();
  const rememberEsignDoc = (doc: Record<string, unknown>) => {
    const docId = String(doc.id ?? "").trim();
    if (!docId) return;
    nestedById.set(
      docId,
      mergeRememberedSignerNames(doc, nestedById.get(docId)),
    );
  };
  for (const row of investments) {
    const docs = await collectCompletedEsignNestedDocuments(
      id,
      row.id,
      "investment",
      row.contactDisplayName ?? "",
      row.profileId,
      matchIdsFor(row.contactId, row.id),
      row.esignStatusJson,
      sponsorDocsGateOpen,
      templates,
      sponsorNamesByEmail,
    );
    for (const doc of docs) rememberEsignDoc(doc);
  }
  for (const row of roster) {
    const docs = await collectCompletedEsignNestedDocuments(
      id,
      row.id,
      "lp",
      row.investorName?.trim() || row.email?.trim() || "",
      row.profileId,
      matchIdsFor(row.contactMemberId, row.id),
      row.esignStatusJson,
      sponsorDocsGateOpen,
      templates,
      sponsorNamesByEmail,
    );
    for (const doc of docs) rememberEsignDoc(doc);
  }

  const { visibility, sections: existingSections } = readPreviewParts(
    deal.offeringInvestorPreviewJson,
  );
  for (const section of existingSections) {
    if (!isEsignTemplateSection(section)) continue;
    const nested = Array.isArray(section.nestedDocuments)
      ? section.nestedDocuments
      : [];
    for (const raw of nested) {
      if (raw == null || typeof raw !== "object") continue;
      const previous = raw as Record<string, unknown>;
      const docId = String(previous.id ?? "").trim();
      const current = docId ? nestedById.get(docId) : undefined;
      if (!current) continue;
      nestedById.set(docId, mergeRememberedSignerNames(current, previous));
    }
  }
  const otherSections = stripInvestorEsignDocumentsFromOtherSections(
    existingSections,
  );

  const esignNested = [...nestedById.values()];
  const hadEsignSection = existingSections.some(isEsignTemplateSection);

  let nextSections = [...otherSections];
  if (esignNested.length > 0 || hadEsignSection) {
    nextSections.push({
      id: ESIGN_TEMPLATE_DOCUMENTS_SECTION_ID,
      sectionLabel: ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL,
      documentLabel: ESIGN_TEMPLATE_DOCUMENTS_SECTION_LABEL,
      visibility: "Sponsor workspace only",
      sharedWithScope: "not_visible",
      requireLpReview: false,
      dateAdded: formatDdMmmYyyy(new Date()),
      nestedDocuments: esignNested,
    });
  }

  const canonical = sanitizeOfferingInvestorPreviewBody({
    visibility,
    sections: nextSections,
  });

  if (canonical === (deal.offeringInvestorPreviewJson ?? "")) return false;

  const updated = await updateDealOfferingInvestorPreviewById(id, canonical);
  return Boolean(updated);
}

/**
 * True when this profile-scoped signature request already appears in the sponsor
 * Documents tab “Investor e signatures” section (authoritative for sponsor counter-sign).
 */
export async function esignSignatureRequestVisibleInDocumentsTab(
  dealId: string,
  signatureRequestId: string,
): Promise<boolean> {
  const id = dealId.trim();
  const sigId = signatureRequestId.trim();
  if (!id || !sigId) return false;

  const deal = await getAddDealFormById(id);
  const { sections } = readPreviewParts(deal?.offeringInvestorPreviewJson);
  for (const section of sections) {
    if (!isEsignTemplateSection(section)) continue;
    const nested = section.nestedDocuments;
    if (!Array.isArray(nested)) continue;
    for (const raw of nested) {
      if (raw == null || typeof raw !== "object") continue;
      const doc = raw as Record<string, unknown>;
      const docSig = String(doc.esignSignatureRequestId ?? "").trim();
      if (docSig === sigId) return true;
      const docId = String(doc.id ?? "").trim();
      if (docId === sigId || docId.startsWith(`${sigId}::`)) return true;
    }
  }
  return false;
}

/** Latest canonical JSON after sync (for API responses). */
export async function readOfferingInvestorPreviewJsonAfterEsignSync(
  dealId: string,
): Promise<string | null> {
  const id = dealId.trim();
  if (!id) return null;
  await syncCompletedEsignDocumentsToDocumentsTab(id);
  const deal = await getAddDealFormById(id);
  return deal?.offeringInvestorPreviewJson ?? null;
}
