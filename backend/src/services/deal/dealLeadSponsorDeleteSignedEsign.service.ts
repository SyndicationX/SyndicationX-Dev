import { unlink } from "node:fs/promises";
import * as path from "node:path";
import { and, eq } from "drizzle-orm";
import { getUploadsPhysicalRoot } from "../../config/uploadPaths.js";
import { getActiveEsignProvider } from "../../config/esignProvider.config.js";
import { db } from "../../database/db.js";
import { dealInvestment } from "../../schema/deal.schema/deal-investment.schema.js";
import { dealLpInvestor } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import {
  findEsignSendBySignatureRequestId,
  parseEsignStatusBundle,
  type StoredDealInvestorEsignSend,
} from "../../constants/deal-investor-esign-status.js";
import { getAddDealFormById } from "./dealForm.service.js";
import {
  findQueueEntryForEsignTarget,
  listDealEsignInvestorQueue,
} from "./dealSequentialEsignWorkflow.service.js";
import {
  commitmentProfileIdForEsignTarget,
  syncDealInvestorEsignByTarget,
} from "./dealMemberEsignCompletion.service.js";
import { resolveEmailForContactMemberId } from "./dealMemberInvitationEmail.service.js";
import { resolveEsignFilesForInvestorProfile } from "./dealEsignProfileTemplate.service.js";
import {
  findInvestorEsignTargetBySignatureRequestId,
  readInvestorEsignStatusJson,
  removeDealInvestorEsignSend,
  markDealInvestorEsignPending,
  type InvestorEsignRowTarget,
} from "./dealMemberEsignStatus.service.js";
import {
  getDealEsignTemplatesState,
  isEsignTemplateReady,
  type EsignTemplateFileRecord,
} from "./dealEsignTemplates.service.js";
import {
  applyInvestorPreviewToEsignDocuments,
  createInvestorSignatureRequest,
  esignDocumentsFromSelectedFiles,
  esignTemplateDisplayNameForFile,
  sendDealMemberSendEsignEmail,
} from "./dealMemberSendEsign.service.js";
import { syncCompletedEsignDocumentsToDocumentsTab } from "./dealEsignDocumentsWorkspaceSync.service.js";

function templateFileIdsFromSend(
  send: StoredDealInvestorEsignSend,
  signatureRequestId: string,
): string[] {
  const sig = signatureRequestId.trim();
  const ids: string[] = [];
  for (const doc of send.documents ?? []) {
    let fileId = doc.fileId.trim();
    if (sig && fileId.startsWith(`${sig}::`)) {
      fileId = fileId.slice(sig.length + 2).trim();
    }
    if (fileId && !ids.includes(fileId)) ids.push(fileId);
  }
  return ids;
}

async function removeStoredPdf(relativePath: string | null | undefined): Promise<void> {
  const rel = relativePath?.trim().replace(/^\/+/, "");
  if (!rel) return;
  try {
    await unlink(path.join(getUploadsPhysicalRoot(), rel));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") console.warn("removeStoredPdf:", err);
  }
}

async function deleteStoredPdfsForSend(
  send: StoredDealInvestorEsignSend,
): Promise<void> {
  const paths = new Set<string>();
  for (const doc of send.documents ?? []) {
    const rel = doc.signedRelativePath?.trim();
    if (rel) paths.add(rel);
  }
  const fullPath = send.fullSignedRelativePath?.trim();
  if (fullPath) paths.add(fullPath);
  const sponsorPath = send.sponsorSignedRelativePath?.trim();
  if (sponsorPath) paths.add(sponsorPath);
  for (const rel of paths) {
    await removeStoredPdf(rel);
  }
}

function signatureLookupIds(raw: string): string[] {
  const id = raw.trim();
  if (!id) return [];
  const ids = [id];
  const head = id.split("::")[0]?.trim() ?? "";
  if (head && head !== id) ids.push(head);
  return ids;
}

function uniqueTemplateFiles(
  files: EsignTemplateFileRecord[],
): EsignTemplateFileRecord[] {
  const seen = new Set<string>();
  const out: EsignTemplateFileRecord[] = [];
  for (const file of files) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    out.push(file);
  }
  return out;
}

/**
 * Lead sponsor removes one signed copy and sends that profile's documents again.
 * The investor is emailed and must sign the new copy.
 */
export async function leadSponsorDeleteSignedEsignAndRequestResign(params: {
  dealId: string;
  signatureRequestId: string;
  templateFileId?: string;
}): Promise<
  | { ok: true; emailSent: boolean; message: string }
  | { ok: false; message: string; code?: string }
> {
  const dealId = params.dealId.trim();
  const requestedSigId = params.signatureRequestId.trim();
  if (!dealId || !requestedSigId) {
    return { ok: false, message: "Missing signature request" };
  }
  if (!getActiveEsignProvider()) {
    return {
      ok: false,
      message: "eSign is not configured, so this document cannot be sent again.",
      code: "not_configured",
    };
  }

  try {
    const rawMatches = await findSignedSendOnDeal(dealId, requestedSigId);
    if (!rawMatches) {
      return { ok: false, message: "That signed document was not found", code: "not_found" };
    }
    const { target } = rawMatches;
    let { send, signatureRequestId: sigId } = rawMatches;

    try {
      await syncDealInvestorEsignByTarget(dealId, target);
      const refreshed = await findSignedSendOnDeal(dealId, sigId);
      if (refreshed) {
        send = refreshed.send;
        sigId = refreshed.signatureRequestId;
      }
    } catch (err) {
      console.warn("syncDealInvestorEsignByTarget before resign:", err);
    }

    const investorSigned = Boolean(
      send.signedAt?.trim() ||
        send.completedAt?.trim() ||
        send.fullSignedRelativePath?.trim() ||
        send.sponsorSignedRelativePath?.trim() ||
        (send.documents ?? []).some((doc) => doc.signedRelativePath?.trim()),
    );
    if (!investorSigned && !send.sentAt?.trim()) {
      return {
        ok: false,
        message: "This document has not been sent for signature",
        code: "not_signed",
      };
    }

    const commitmentProfileId =
      (await commitmentProfileIdForEsignTarget(dealId, target)) ?? undefined;
    const batches = await templateBatchesForResign({
      dealId,
      send,
      signatureRequestId: sigId,
      templateFileId: params.templateFileId,
      commitmentProfileId,
    });
    if (batches.length === 0) {
      return {
        ok: false,
        message:
          "No saved eSign template is available for this profile, so the investor cannot be asked to sign again.",
      };
    }

    const recipient = await investorRecipientForTarget(dealId, target);
    if (!recipient) {
      return {
        ok: false,
        message: "This investor has no email address, so they cannot be asked to sign again",
      };
    }

    const deal = await getAddDealFormById(dealId);
    const dealName = deal?.dealName?.trim() || "Deal";
    let selectedFiles: EsignTemplateFileRecord[] | null = null;
    let signatureRequestId: string | undefined;
    let signatureId: string | undefined;
    let investorPreviewRelativePath: string | undefined;
    let lastMessage = "Could not create a new signature request";

    for (const batch of batches) {
      try {
        const created = await createInvestorSignatureRequest({
          dealId,
          rosterId: target.id,
          toEmail: recipient.email,
          memberDisplayName: recipient.displayName,
          dealName,
          selectedFiles: batch,
          esignTarget: target,
          commitmentProfileId,
        });
        if (!created?.signatureRequestId) {
          lastMessage = "Could not create a new signature request";
          continue;
        }
        selectedFiles = batch;
        signatureRequestId = created.signatureRequestId;
        signatureId = created.signatureId;
        investorPreviewRelativePath = created.investorPreviewRelativePath;
        break;
      } catch (err) {
        lastMessage =
          err instanceof Error ? err.message : "Could not create a new signature request";
      }
    }

    if (!selectedFiles || !signatureRequestId) {
      return { ok: false, message: lastMessage };
    }

    await deleteStoredPdfsForSend(send);
    await removeDealInvestorEsignSend(dealId, target, sigId);
    await markDealInvestorEsignPending(dealId, {
      target,
      rosterId: target.id,
      toEmail: recipient.email,
      documents: applyInvestorPreviewToEsignDocuments(
        esignDocumentsFromSelectedFiles(selectedFiles),
        investorPreviewRelativePath,
      ),
      signatureRequestId,
      signatureId,
    });

    const email = await sendDealMemberSendEsignEmail({
      dealId,
      toEmail: recipient.email,
      memberDisplayName: recipient.displayName,
      documentNames: selectedFiles.map((file) =>
        esignTemplateDisplayNameForFile(file),
      ),
    });

    try {
      await syncCompletedEsignDocumentsToDocumentsTab(dealId);
    } catch (err) {
      console.warn("syncCompletedEsignDocumentsToDocumentsTab:", err);
    }

    if (!email.ok) {
      return {
        ok: true,
        emailSent: false,
        message:
          "The signed document was removed and a new signature request was created, but the email could not be sent.",
      };
    }

    return {
      ok: true,
      emailSent: true,
      message: "The investor was emailed to sign this profile again.",
    };
  } catch (err) {
    console.error("leadSponsorDeleteSignedEsignAndRequestResign:", err);
    const message =
      err instanceof Error && err.message.trim()
        ? err.message.trim()
        : "Could not delete this signed document";
    return { ok: false, message };
  }
}

async function templateBatchesForResign(params: {
  dealId: string;
  send: StoredDealInvestorEsignSend;
  signatureRequestId: string;
  templateFileId?: string;
  commitmentProfileId?: string;
}): Promise<EsignTemplateFileRecord[][]> {
  const provider = getActiveEsignProvider();
  const state = await getDealEsignTemplatesState(params.dealId);
  const wanted = new Set(templateFileIdsFromSend(params.send, params.signatureRequestId));
  const clicked = params.templateFileId?.trim() ?? "";
  if (clicked) wanted.add(clicked);
  const fromSend = state.files.filter((file) => wanted.has(file.id));
  const fromProfile = await resolveEsignFilesForInvestorProfile(
    state.files,
    params.commitmentProfileId,
  );
  const ready = (files: EsignTemplateFileRecord[]) =>
    files.filter((file) => isEsignTemplateReady(file, provider));
  const clickedReady = clicked
    ? ready(fromSend.filter((file) => file.id === clicked))
    : [];
  const ordered = uniqueTemplateFiles([
    ...clickedReady,
    ...ready(fromSend),
    ...ready(fromProfile),
  ]);
  if (ordered.length === 0) return [];
  if (provider === "signflow") {
    return ordered.slice(0, 4).map((file) => [file]);
  }
  return [ordered.slice(0, 8)];
}

async function investorRecipientForTarget(
  dealId: string,
  target: InvestorEsignRowTarget,
): Promise<{ email: string; displayName: string } | null> {
  const queue = await listDealEsignInvestorQueue(dealId);
  const entry = await findQueueEntryForEsignTarget(dealId, queue, target);
  const queuedEmail = entry?.email?.trim().toLowerCase() ?? "";
  if (queuedEmail.includes("@")) {
    return {
      email: queuedEmail,
      displayName: entry?.displayName?.trim() || "Investor",
    };
  }

  if (target.table === "investment") {
    const [row] = await db
      .select({
        contactId: dealInvestment.contactId,
        contactDisplayName: dealInvestment.contactDisplayName,
      })
      .from(dealInvestment)
      .where(
        and(eq(dealInvestment.id, target.id), eq(dealInvestment.dealId, dealId)),
      )
      .limit(1);
    const email =
      (await resolveEmailForContactMemberId(String(row?.contactId ?? ""))) ?? "";
    if (!email.includes("@")) return null;
    return {
      email,
      displayName: row?.contactDisplayName?.trim() || "Investor",
    };
  }

  const [row] = await db
    .select({
      email: dealLpInvestor.email,
      contactMemberId: dealLpInvestor.contactMemberId,
    })
    .from(dealLpInvestor)
    .where(and(eq(dealLpInvestor.id, target.id), eq(dealLpInvestor.dealId, dealId)))
    .limit(1);
  const email =
    row?.email?.trim().toLowerCase() ||
    (await resolveEmailForContactMemberId(String(row?.contactMemberId ?? ""))) ||
    "";
  if (!email.includes("@")) return null;
  return { email, displayName: "Investor" };
}

async function findSignedSendOnDeal(
  dealId: string,
  signatureRequestId: string,
): Promise<{
  target: InvestorEsignRowTarget;
  send: StoredDealInvestorEsignSend;
  signatureRequestId: string;
} | null> {
  for (const candidate of signatureLookupIds(signatureRequestId)) {
    const target = await findInvestorEsignTargetBySignatureRequestId(
      dealId,
      candidate,
    );
    if (!target) continue;
    const raw = await readInvestorEsignStatusJson(dealId, target);
    const bundle = parseEsignStatusBundle(raw);
    const send = bundle
      ? findEsignSendBySignatureRequestId(bundle, candidate)
      : null;
    if (!send) continue;
    return {
      target,
      send,
      signatureRequestId: send.signatureRequestId?.trim() || candidate,
    };
  }
  return null;
}
