import { getActiveEsignProvider } from "../../config/esignProvider.config.js";
import { getSignFlowPublicConfig } from "../../config/signflow.config.js";
import {
  findEsignSendBySignatureRequestId,
  esignSendReadyForSponsorCounterSign,
  parseEsignStatusBundle,
} from "../../constants/deal-investor-esign-status.js";
import { getDealEsignDropboxSignPublicConfig } from "./dealEsignDropboxSign.service.js";
import {
  listDealSponsorSignerOptions,
  resolveDealMemberSignerByRowId,
  type DealMemberSignerOption,
} from "./dealEsignSigningWorkflow.service.js";
import {
  buildSignFlowSignerEmbedUrl,
  createSignFlowSponsorEmbedSigningSession,
  ensureParallelPartiesMaySign,
  evaluateSignFlowRecipientSignAccess,
  getSignFlowDocument,
  normalizeSignFlowFieldsForApi,
  patchSignFlowDocument,
  isSignFlowOpenSponsorRecipient,
  signFlowCounterSignRequiresInvestorSigned,
  signFlowPendingSponsorSignAudience,
  signFlowRecipientHasSigned,
  signFlowInvestorPhaseComplete,
  signFlowTemplateHasSponsorFields,
} from "../esign/signflow.service.js";
import { syncDealInvestorEsignByTarget } from "./dealMemberEsignCompletion.service.js";
import { applyEditableSigningDatePrefill } from "./investorQuestionnaireEsignPrefill.service.js";
import { choiceFieldSourcesForDealFiles } from "./dealEsignSignflow.service.js";
import { restoreFlattenedChoiceFields } from "./esignPdfMerge.service.js";
import { limitAlternateSignatureFieldsForSigner } from "./esignAlternateSignature.service.js";
import type { SignFlowField } from "../esign/signflow.service.js";
import {
  findInvestorEsignContextBySignatureRequestId,
  readInvestorEsignStatusJson,
  rememberSponsorSignerOnEsignSend,
} from "./dealMemberEsignStatus.service.js";
import {
  isPortalUserLeadOrAdminSponsorOnDeal,
  isPortalUserSponsorOnDeal,
} from "./dealMemberScope.service.js";
import { getEmbeddedSignUrl, getFirstSignatureIdFromRequest } from "../esign/dropboxSign.service.js";

/** True when sponsor counter-sign must wait for investor signature (sequential investor-first). */
async function sponsorCounterSignRequiresInvestorSigned(
  signatureRequestId: string,
): Promise<boolean> {
  const sigId = signatureRequestId.trim();
  if (!sigId) return true;
  try {
    const doc = await getSignFlowDocument(sigId);
    return signFlowCounterSignRequiresInvestorSigned(doc);
  } catch {
    return true;
  }
}

export type DealSponsorEsignSignSessionResult =
  | {
      ok: true;
      alreadyCompleted: boolean;
      needsSignerSelection?: boolean;
      provider: "signflow" | "dropbox";
      signUrl: string | null;
      clientId: string | null;
      testMode: boolean;
      configured: boolean;
      signatureRequestId: string;
      embedApiKey?: string | null;
      appBaseUrl?: string | null;
      documentId?: string | null;
      canAssignSigner: boolean;
      signerOptions: DealMemberSignerOption[];
      assignedSignerEmail: string;
      assignedSignerName: string;
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "not_configured"
        | "forbidden"
        | "not_ready"
        | "waiting_for_prior_signer";
      message: string;
      waitingFor?: "sponsor" | "investor";
    };

async function resolveSponsorSignerForSession(params: {
  dealId: string;
  sponsorUserId: string;
  sponsorEmail: string;
  assigneeMemberRowId?: string;
}): Promise<
  | { ok: true; signer: { email: string; name: string } }
  | { ok: false; code: "forbidden" | "not_found"; message: string }
> {
  const dealId = params.dealId.trim();
  const sponsorEmail = params.sponsorEmail.trim().toLowerCase();
  const assigneeId = params.assigneeMemberRowId?.trim();

  if (assigneeId) {
    const canAssign = await isPortalUserLeadOrAdminSponsorOnDeal(
      dealId,
      params.sponsorUserId,
    );
    if (!canAssign) {
      return {
        ok: false,
        code: "forbidden",
        message: "Only the lead sponsor or admin sponsor can assign who signs",
      };
    }
    const assignee = await resolveDealMemberSignerByRowId(dealId, assigneeId);
    if (!assignee) {
      return {
        ok: false,
        code: "not_found",
        message: "Selected deal member cannot sign this document",
      };
    }
    return { ok: true, signer: assignee };
  }

  const options = await listDealSponsorSignerOptions(dealId);
  const self = options.find((o) => o.email === sponsorEmail);
  if (self) {
    return { ok: true, signer: { email: self.email, name: self.name } };
  }

  if (sponsorEmail.includes("@")) {
    return { ok: true, signer: { email: sponsorEmail, name: sponsorEmail } };
  }

  return {
    ok: false,
    code: "not_found",
    message: "No sponsor signer is available for this deal",
  };
}

/**
 * Embedded sign session for sponsor counter-signature on investor-completed eSign docs.
 */
export async function getDealSponsorEsignSignSession(params: {
  dealId: string;
  sponsorUserId: string;
  sponsorEmail: string;
  signatureRequestId: string;
  assigneeMemberRowId?: string;
}): Promise<DealSponsorEsignSignSessionResult> {
  const provider = getActiveEsignProvider();
  const signFlowCfg = getSignFlowPublicConfig();
  const dropboxCfg = getDealEsignDropboxSignPublicConfig();

  if (!provider) {
    return {
      ok: false,
      code: "not_configured",
      message: "eSign is not configured on the server",
    };
  }

  const dealId = params.dealId.trim();
  const sigId = params.signatureRequestId.trim();
  let assigneeMemberRowId = params.assigneeMemberRowId?.trim() ?? "";
  if (!dealId || !sigId) {
    return {
      ok: false,
      code: "not_found",
      message: "Missing deal or signature request",
    };
  }

  const isSponsor = await isPortalUserSponsorOnDeal(dealId, params.sponsorUserId);
  if (!isSponsor) {
    return {
      ok: false,
      code: "forbidden",
      message: "Only deal sponsors can counter-sign investor eSign documents",
    };
  }

  const context = await findInvestorEsignContextBySignatureRequestId(sigId);
  if (!context || context.dealId !== dealId) {
    return {
      ok: false,
      code: "not_found",
      message: "eSign document not found on this deal",
    };
  }

  const rawBeforeSync = await readInvestorEsignStatusJson(dealId, context.target);
  const bundleBeforeSync = parseEsignStatusBundle(rawBeforeSync);
  const sendBeforeSync = bundleBeforeSync
    ? findEsignSendBySignatureRequestId(bundleBeforeSync, sigId)
    : null;
  const portalInvestorSigned =
    sendBeforeSync != null &&
    esignSendReadyForSponsorCounterSign(sendBeforeSync);

  try {
    await syncDealInvestorEsignByTarget(dealId, context.target);
  } catch (err) {
    console.warn("getDealSponsorEsignSignSession pre-sync:", err);
  }

  const raw = await readInvestorEsignStatusJson(dealId, context.target);
  const bundle = parseEsignStatusBundle(raw);
  const send = bundle
    ? findEsignSendBySignatureRequestId(bundle, sigId)
    : null;
  if (!send?.sentAt?.trim()) {
    return {
      ok: false,
      code: "not_ready",
      message: "This eSign request has not been sent yet",
    };
  }

  const portalReadyForSponsor =
    portalInvestorSigned || esignSendReadyForSponsorCounterSign(send);

  let investorSigned = portalReadyForSponsor;
  let requiresInvestorFirst = false;

  if (!portalReadyForSponsor) {
    investorSigned = esignSendReadyForSponsorCounterSign(send);
    requiresInvestorFirst =
      provider !== "signflow"
        ? true
        : await sponsorCounterSignRequiresInvestorSigned(sigId);

    if (provider === "signflow") {
      try {
        const liveDoc = await getSignFlowDocument(sigId);
        investorSigned =
          investorSigned || signFlowInvestorPhaseComplete(liveDoc);
        requiresInvestorFirst =
          signFlowCounterSignRequiresInvestorSigned(liveDoc);
        if (investorSigned) {
          await syncDealInvestorEsignByTarget(dealId, context.target);
        }
      } catch (err) {
        console.warn("getDealSponsorEsignSignSession investor sign check:", err);
      }
    }
  }

  if (!portalReadyForSponsor && !investorSigned && requiresInvestorFirst) {
    return {
      ok: false,
      code: "waiting_for_prior_signer",
      message:
        "At least one investor must sign first. Sponsor signing will open after an investor completes their signature.",
      waitingFor: "investor",
    };
  }

  if (send.completedAt?.trim()) {
    let sponsorStillPending = false;
    if (provider === "signflow") {
      try {
        const liveDoc = await getSignFlowDocument(sigId);
        sponsorStillPending =
          signFlowTemplateHasSponsorFields(liveDoc) &&
          !signFlowPendingSponsorSignAudience(liveDoc).allSponsorSlotsSigned;
      } catch (err) {
        console.warn("getDealSponsorEsignSignSession completion check:", err);
      }
    }
    if (!sponsorStillPending) {
      const canAssign = await isPortalUserLeadOrAdminSponsorOnDeal(
        dealId,
        params.sponsorUserId,
      );
      const signerOptions = canAssign
        ? await listDealSponsorSignerOptions(dealId)
        : [];
      return {
        ok: true,
        alreadyCompleted: true,
        provider: provider ?? "dropbox",
        signUrl: null,
        clientId: provider === "signflow" ? null : dropboxCfg.clientId,
        testMode:
          provider === "signflow" ? signFlowCfg.testMode : dropboxCfg.testMode,
        configured: true,
        signatureRequestId: sigId,
        embedApiKey: provider === "signflow" ? signFlowCfg.embedApiKey : null,
        appBaseUrl: provider === "signflow" ? signFlowCfg.appBaseUrl : null,
        documentId: sigId,
        canAssignSigner: canAssign,
        signerOptions,
        assignedSignerEmail: "",
        assignedSignerName: "",
      };
    }
  }

  const canAssign = await isPortalUserLeadOrAdminSponsorOnDeal(
    dealId,
    params.sponsorUserId,
  );
  const signerOptions = canAssign
    ? await listDealSponsorSignerOptions(dealId)
    : [];

  if (canAssign && !assigneeMemberRowId && signerOptions.length === 1) {
    assigneeMemberRowId = signerOptions[0]!.rowId;
  }
  // "Who will sign for the sponsor?" is not shown. The sponsor who opened
  // the document is the signer, so multiple deal sponsors do not get a picker.

  const signerResolved = await resolveSponsorSignerForSession({
    dealId,
    sponsorUserId: params.sponsorUserId,
    sponsorEmail: params.sponsorEmail,
    assigneeMemberRowId: assigneeMemberRowId || undefined,
  });
  if (!signerResolved.ok) {
    return {
      ok: false,
      code: signerResolved.code,
      message: signerResolved.message,
    };
  }
  const signer = signerResolved.signer;

  if (provider === "signflow") {
    try {
      let liveDoc = await getSignFlowDocument(sigId);
      try {
        liveDoc = await ensureParallelPartiesMaySign(sigId, liveDoc);
      } catch (err) {
        console.warn("ensureParallelPartiesMaySign (sponsor):", err);
      }
      if (!signFlowTemplateHasSponsorFields(liveDoc)) {
        return {
          ok: false,
          code: "not_ready",
          message: "This document does not require a sponsor signature",
        };
      }

      const investorHasCompletedSignature =
        esignSendReadyForSponsorCounterSign(send) ||
        signFlowInvestorPhaseComplete(liveDoc);

      const signerEmail = signer.email.trim().toLowerCase();
      const signerName = signer.name.trim() || signerEmail;
      const sponsorRecipients = (liveDoc.recipients ?? []).filter((recipient) => {
        const role = String(recipient.role ?? "").trim().toLowerCase();
        return role === "seller" || role.includes("sponsor");
      });
      const unsigned = sponsorRecipients.filter(
        (recipient) => !signFlowRecipientHasSigned(recipient),
      );
      const recipientOwnsFields = (recipientId: string | undefined) => {
        const id = recipientId?.trim();
        if (!id) return false;
        return (liveDoc.fields ?? []).some(
          (field) => String(field.recipientId ?? "").trim() === id,
        );
      };
      const namedMine = unsigned.find(
        (recipient) =>
          !isSignFlowOpenSponsorRecipient(recipient) &&
          String(recipient.email ?? "").trim().toLowerCase() === signerEmail,
      );
      const openWithFields = unsigned.find(
        (recipient) =>
          isSignFlowOpenSponsorRecipient(recipient) &&
          recipientOwnsFields(recipient.id),
      );
      const namedWithFields =
        namedMine && recipientOwnsFields(namedMine.id) ? namedMine : undefined;
      // This sponsor's assigned fields open on their own recipient. Unsigned
      // Any sponsor fields are added in the signing view. Other sponsors only
      // get the shared slot.
      const sponsorRecipient =
        namedWithFields ??
        openWithFields ??
        namedMine ??
        unsigned.find((recipient) => isSignFlowOpenSponsorRecipient(recipient));
      if (!sponsorRecipient) {
        const assignedToOther = unsigned.some(
          (recipient) => !isSignFlowOpenSponsorRecipient(recipient),
        );
        if (!assignedToOther) {
          return {
            ok: true,
            alreadyCompleted: true,
            provider: "signflow",
            signUrl: null,
            clientId: null,
            testMode: signFlowCfg.testMode,
            configured: signFlowCfg.configured,
            signatureRequestId: sigId,
            embedApiKey: signFlowCfg.embedApiKey,
            appBaseUrl: signFlowCfg.appBaseUrl,
            documentId: sigId,
            canAssignSigner: canAssign,
            signerOptions,
            assignedSignerEmail: "",
            assignedSignerName: "",
          };
        }
        return {
          ok: false,
          code: "not_ready",
          message:
            "This signature is assigned to another sponsor. Sign in as that sponsor to counter-sign.",
        };
      }

      let docForSession = liveDoc;
      const sponsorRecipientId = sponsorRecipient?.id?.trim();
      if (sponsorRecipientId) {
        try {
          const sources = await choiceFieldSourcesForDealFiles(
            dealId,
            (send.documents ?? []).map((doc) => doc.fileId),
          );
          const restored = restoreFlattenedChoiceFields(
            (docForSession.fields ?? []) as SignFlowField[],
            sources,
          );
          const limited = await limitAlternateSignatureFieldsForSigner({
            doc: docForSession,
            fields: restored.fields,
            recipientId: sponsorRecipientId,
            signerName,
          });
          const refreshed = applyEditableSigningDatePrefill(
            limited.fields,
            sponsorRecipientId,
          );
          if (restored.changed || limited.changed || refreshed.changed) {
            docForSession = await patchSignFlowDocument(sigId, {
              fields: normalizeSignFlowFieldsForApi(refreshed.fields),
            });
          }
        } catch (err) {
          console.warn("refresh sponsor signing fields:", err);
        }
      }

      const sessionEmail =
        String(sponsorRecipient.email ?? "").trim() || signer.email;
      const access = evaluateSignFlowRecipientSignAccess(
        docForSession,
        sessionEmail,
        { investorHasCompletedSignature },
      );
      if (!access.allowed && !portalReadyForSponsor) {
        return {
          ok: false,
          code: "waiting_for_prior_signer",
          message: access.message,
          waitingFor: access.waitingFor,
        };
      }

      let signUrl = buildSignFlowSignerEmbedUrl(sigId);
      try {
        const session = await createSignFlowSponsorEmbedSigningSession({
          documentId: sigId,
          recipientEmail: sessionEmail,
          recipientId: sponsorRecipient.id?.trim(),
          investorPhaseComplete: investorHasCompletedSignature,
        });
        signUrl = session.signUrl;
        const assignedRecipientId = namedWithFields?.id?.trim();
        if (assignedRecipientId) {
          try {
            const signLink = new URL(signUrl);
            signLink.searchParams.set("assignedRecipientId", assignedRecipientId);
            signUrl = signLink.toString();
          } catch {
            const joiner = signUrl.includes("?") ? "&" : "?";
            signUrl = `${signUrl}${joiner}assignedRecipientId=${encodeURIComponent(assignedRecipientId)}`;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          !portalReadyForSponsor &&
          (message.includes("WAITING_FOR_PRIOR_SIGNER") ||
            message.toLowerCase().includes("investor must sign"))
        ) {
          return {
            ok: false,
            code: "waiting_for_prior_signer",
            message: message.replace(/^WAITING_FOR_PRIOR_SIGNER:\s*/i, "").trim(),
            waitingFor: "investor",
          };
        }
        console.warn("createSignFlowEmbedSigningSession (sponsor):", err);
        return {
          ok: false,
          code: "not_ready",
          message: portalReadyForSponsor
            ? "Could not open sponsor signing. Confirm SignFlow is running and try again."
            : "Could not load sponsor signing session",
        };
      }

      void rememberSponsorSignerOnEsignSend({
        dealId,
        signatureRequestId: sigId,
        name: signer.name,
        email: signer.email,
        overwrite: true,
      }).catch((err) => console.warn("remember sponsor signer:", err));

      return {
        ok: true,
        alreadyCompleted: false,
        provider: "signflow",
        signUrl,
        clientId: null,
        testMode: signFlowCfg.testMode,
        configured: signFlowCfg.configured,
        signatureRequestId: sigId,
        embedApiKey: signFlowCfg.embedApiKey,
        appBaseUrl: signFlowCfg.appBaseUrl,
        documentId: sigId,
        canAssignSigner: canAssign,
        signerOptions,
        assignedSignerEmail: signer.email,
        assignedSignerName: signer.name,
      };
    } catch (err) {
      console.warn("getDealSponsorEsignSignSession signflow prep:", err);
      return {
        ok: false,
        code: "not_ready",
        message: "Could not prepare sponsor signing session",
      };
    }
  }

  const signatureId = await getFirstSignatureIdFromRequest(sigId);
  if (!signatureId) {
    return {
      ok: false,
      code: "not_ready",
      message: "Could not resolve sponsor signing session",
    };
  }

  try {
    const { signUrl } = await getEmbeddedSignUrl(signatureId);
    return {
      ok: true,
      alreadyCompleted: false,
      provider: "dropbox",
      signUrl,
      clientId: dropboxCfg.clientId,
      testMode: dropboxCfg.testMode,
      configured: dropboxCfg.configured,
      signatureRequestId: sigId,
      canAssignSigner: canAssign,
      signerOptions,
      assignedSignerEmail: signer.email,
      assignedSignerName: signer.name,
    };
  } catch (err) {
    console.warn("getDealSponsorEsignSignSession dropbox:", err);
    return {
      ok: false,
      code: "not_ready",
      message: "Could not load sponsor signing session",
    };
  }
}
