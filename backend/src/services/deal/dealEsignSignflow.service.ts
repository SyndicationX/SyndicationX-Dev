import { getSignFlowPublicConfig } from "../../config/signflow.config.js";
import {
  buildSignFlowEditorUrl,
  countSignFlowPdfPages,
  createSignFlowDraftFromPdf,
  ensureSignFlowEmbedRecipients,
  getSignFlowDocument,
  normalizeSignFlowFieldRecipientIds,
  patchSignFlowDocument,
  resolveSignFlowFieldTemplateAnchor,
  resolveSignFlowInvestorRecipientId,
  type SignFlowField,
} from "../esign/signflow.service.js";
import {
  esignDocumentAlignedTextFieldSize,
  expandShrunkChoiceFieldsForEditor,
  isQuestionnaireSignatureFieldLabel,
  normalizeSignFlowChoiceFieldOptionNumbers,
} from "./esignPdfMerge.service.js";
import { inferSigningWorkflowFromSignFlowDocument, resolveSigningWorkflowFromTemplateFile, syncDealSponsorsOntoSignFlowTemplate } from "./dealEsignSigningWorkflow.service.js";
import {
  ESIGN_TEMPLATE_PDF_MISSING_MESSAGE,
  ensureEsignTemplatePdfPrepared,
  findEsignTemplateFile,
  getDealEsignTemplatesState,
  isPdfEsignFile,
  readEsignTemplatePdfBuffer,
  type EsignTemplateFileRecord,
  type EsignTemplatesJson,
  type SignflowInvestorDataFieldBinding,
} from "./dealEsignTemplates.service.js";
import { eq } from "drizzle-orm";
import { db } from "../../database/db.js";
import { addDealForm } from "../../schema/deal.schema/add-deal-form.schema.js";
import { computePdfPageFingerprints } from "./esignPdfPageMap.service.js";
import {
  ALL_SIGNFLOW_PROFILE_TYPES,
  portalProfileIdToSignFlowProfileType,
  type SignFlowProfileType,
} from "../../constants/esignProfileTypes.js";
import {
  ESIGN_LABEL_TO_PROFILE_KEY,
  getEsignInvestorDataField,
  normalizeEsignFieldLabel,
} from "./esignInvestorDataFieldCatalog.js";

function templateFileId(raw: string): string {
  const id = raw.trim();
  const parts = id.split("::");
  return (parts[parts.length - 1] ?? id).trim();
}

/** Radio/checkbox fields from the deal template, used to repair a sent copy. */
export async function choiceFieldSourcesForDealFiles(
  dealId: string,
  fileIds: string[],
): Promise<SignFlowField[]> {
  const wanted = new Set(fileIds.map(templateFileId).filter(Boolean));
  const state = await getDealEsignTemplatesState(dealId);
  const files = state.files.filter(
    (file) => wanted.size === 0 || wanted.has(file.id),
  );
  const snapshot = files.flatMap((file) => file.signflowTemplateFields ?? []);
  if (
    snapshot.some((field) => {
      const type = String(field.type ?? "").trim().toLowerCase();
      return type === "radio" || type === "checkbox";
    })
  ) {
    return snapshot;
  }

  const live: SignFlowField[] = [];
  for (const file of files) {
    const documentId = file.signflowDocumentId?.trim();
    if (!documentId) continue;
    try {
      const doc = await getSignFlowDocument(documentId);
      live.push(...((doc.fields ?? []) as SignFlowField[]));
    } catch (err) {
      console.warn("choiceFieldSourcesForDealFiles:", err);
    }
  }
  return live;
}

function isMissingTemplatePdfError(err: unknown): boolean {
  return (
    err instanceof Error && err.message === ESIGN_TEMPLATE_PDF_MISSING_MESSAGE
  );
}

async function captureSignFlowTemplateFieldsForStorage(
  dealId: string,
  file: EsignTemplateFileRecord,
  doc: Awaited<ReturnType<typeof getSignFlowDocument>>,
): Promise<SignFlowField[]> {
  const state = await getDealEsignTemplatesState(dealId);
  await ensureEsignTemplatePdfPrepared(dealId, file, state);
  const pdfBuffer = await readEsignTemplatePdfBuffer(file.relativePath);
  const hashes = await computePdfPageFingerprints(pdfBuffer);
  const normalized = normalizeSignFlowFieldRecipientIds(
    doc,
    (doc.fields ?? []) as SignFlowField[],
  ) as SignFlowField[];

  return normalized.map((field) => {
    const { templatePage } = resolveSignFlowFieldTemplateAnchor(field);
    return {
      ...field,
      page: templatePage,
      templatePage,
      pageHash: hashes[templatePage - 1],
    };
  });
}

async function persistEsignTemplatesJson(
  dealId: string,
  state: EsignTemplatesJson,
): Promise<void> {
  await db
    .update(addDealForm)
    .set({ esignTemplatesJson: JSON.stringify(state) })
    .where(eq(addDealForm.id, dealId));
}

async function applyTemplateSigningWorkflowToSignFlowDoc(
  file: EsignTemplateFileRecord,
  documentId: string,
): Promise<void> {
  const { workflowType, signingOrder } =
    resolveSigningWorkflowFromTemplateFile(file);
  const { syncSignflowTemplateSigningWorkflow } = await import(
    "./dealEsignSigningWorkflow.service.js"
  );
  await syncSignflowTemplateSigningWorkflow(
    documentId,
    workflowType,
    signingOrder,
  );
}

/**
 * If opening the editor cleared the live document, put the last saved fields back.
 * An empty saved layout stays empty, so a document the sponsor cleared stays clear.
 */
async function restoreStoredFieldsIfLiveEmpty(
  documentId: string,
  file: EsignTemplateFileRecord,
): Promise<void> {
  const stored = file.signflowTemplateFields;
  if (!stored?.length) return;

  const doc = await getSignFlowDocument(documentId);
  if ((doc.fields?.length ?? 0) > 0) return;

  await patchSignFlowDocument(documentId, {
    fields: normalizeSignFlowFieldRecipientIds(doc, stored),
  });
}

/** Remove questionnaire signature fields when the sponsor did not include questionnaire. */
async function stripQuestionnaireSignatureFieldsIfDisabled(
  documentId: string,
  includeQuestionnaire: boolean,
): Promise<void> {
  if (includeQuestionnaire) return;

  const doc = await getSignFlowDocument(documentId);
  const existing = doc.fields ?? [];
  const filtered = existing.filter((field) => {
    const page = Math.max(1, Math.floor(Number(field.page) || 1));
    if (page !== 1) return true;
    return !isQuestionnaireSignatureFieldLabel(String(field.label ?? ""));
  });

  if (filtered.length === existing.length) return;

  await patchSignFlowDocument(documentId, {
    fields: normalizeSignFlowFieldRecipientIds(doc, filtered),
  });
}

/** Auto-place investor + sponsor fields on each PDF page via Python service. */
function signFlowFieldsPlacementChanged(
  before: SignFlowField[],
  after: SignFlowField[],
): boolean {
  if (before.length !== after.length) return true;
  const norm = (fields: SignFlowField[]) =>
    fields
      .map((field) => ({
        label: String(field.label ?? "").trim().toLowerCase(),
        page: Math.max(1, Math.floor(Number(field.page) || 1)),
        x: Math.round(Number(field.x) * 10) / 10,
        y: Math.round(Number(field.y) * 10) / 10,
        w: Math.round(Number(field.width) * 10) / 10,
        h: Math.round(Number(field.height) * 10) / 10,
        recipientId: String(field.recipientId ?? "").trim(),
      }))
      .sort((a, b) =>
        `${a.page}|${a.label}|${a.x}|${a.y}`.localeCompare(
          `${b.page}|${b.label}|${b.x}|${b.y}`,
        ),
      );

  return JSON.stringify(norm(before)) !== JSON.stringify(norm(after));
}

export async function startDealEsignSignflowTemplateDraft(params: {
  dealId: string;
  fileId: string;
  title?: string;
}): Promise<{
  file: EsignTemplateFileRecord;
  editUrl: string;
  templateId: string;
  expiresAt: number;
  provider: "signflow";
  embedApiKey: string | null;
  appBaseUrl: string;
  testMode: boolean;
}> {
  const publicCfg = getSignFlowPublicConfig();
  if (!publicCfg.configured || !publicCfg.appBaseUrl) {
    throw new Error(
      "SignFlow is not configured. Set SIGNFLOW_API_BASE_URL and SIGNFLOW_API_KEY in backend/.env",
    );
  }

  const state = await getDealEsignTemplatesState(params.dealId);
  const file = findEsignTemplateFile(state, params.fileId);
  if (!file) throw new Error("eSign template file not found");
  if (!isPdfEsignFile(file)) {
    throw new Error(
      "Only PDF documents can be configured for eSign. Convert Word files to PDF before uploading.",
    );
  }

  const title =
    params.title?.trim() ||
    file.templateName?.trim() ||
    file.signflowTitle?.trim() ||
    file.dropboxSignTitle?.trim() ||
    file.originalName.replace(/\.pdf$/i, "") ||
    "Deal eSign template";

  const existingDocId = file.signflowDocumentId?.trim() ?? "";
  const canResumeExisting =
    existingDocId &&
    (file.signflowStatus === "draft" || file.signflowStatus === "ready");

  try {
    await ensureEsignTemplatePdfPrepared(params.dealId, file, state);
  } catch (err) {
    if (!canResumeExisting || !isMissingTemplatePdfError(err)) throw err;
  }

  if (canResumeExisting) {
    await ensureSignFlowEmbedRecipients(existingDocId);
    await syncDealSponsorsOntoSignFlowTemplate(existingDocId, params.dealId);
    await stripQuestionnaireSignatureFieldsIfDisabled(
      existingDocId,
      Boolean(file.includeQuestionnaire),
    );
    await applyTemplateSigningWorkflowToSignFlowDoc(file, existingDocId);
    await restoreStoredFieldsIfLiveEmpty(existingDocId, file);
    await restorePlacedChoiceFieldSizes(existingDocId);
    return {
      file,
      editUrl: buildSignFlowEditorUrl(existingDocId),
      templateId: existingDocId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      provider: "signflow",
      embedApiKey: publicCfg.embedApiKey,
      appBaseUrl: publicCfg.appBaseUrl,
      testMode: publicCfg.testMode,
    };
  }

  const fileBuffer = await readEsignTemplatePdfBuffer(file.relativePath);
  const pdfPageCount = await countSignFlowPdfPages(fileBuffer);

  let documentId = existingDocId;
  if (documentId) {
    try {
      const existing = await getSignFlowDocument(documentId);
      if (!existing.fileUrl?.trim()) {
        documentId = "";
        delete file.signflowDocumentId;
        delete file.signflowStatus;
      } else {
        const storedPages = Math.max(1, Number(existing.pages) || 1);
        if (pdfPageCount > storedPages) {
          await patchSignFlowDocument(documentId, { pages: pdfPageCount });
        }
      }
    } catch {
      documentId = "";
      delete file.signflowDocumentId;
      delete file.signflowStatus;
    }
  }

  if (!documentId) {
    const draft = await createSignFlowDraftFromPdf({
      title,
      pdfBuffer: fileBuffer,
      fileName: file.originalName,
      pages: pdfPageCount,
    });
    documentId = draft.documentId;
    file.signflowDocumentId = documentId;
    file.signflowStatus = "draft";
    file.signflowTitle = title;
    file.esignProvider = "signflow";
    await persistEsignTemplatesJson(params.dealId, state);
  }

  await ensureSignFlowEmbedRecipients(documentId);
  await syncDealSponsorsOntoSignFlowTemplate(documentId, params.dealId);
  await stripQuestionnaireSignatureFieldsIfDisabled(
    documentId,
    Boolean(file.includeQuestionnaire),
  );
  await applyTemplateSigningWorkflowToSignFlowDoc(file, documentId);

  return {
    file,
    editUrl: buildSignFlowEditorUrl(documentId),
    templateId: documentId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    provider: "signflow",
    embedApiKey: publicCfg.embedApiKey,
    appBaseUrl: publicCfg.appBaseUrl,
    testMode: publicCfg.testMode,
  };
}

/**
 * Boxes saved at the tiny signer size are put back to the size used when the
 * sponsor added them. Larger boxes the sponsor resized are left as they are.
 */
async function restorePlacedChoiceFieldSizes(documentId: string): Promise<void> {
  const doc = await getSignFlowDocument(documentId);
  const existing = (doc.fields ?? []) as SignFlowField[];
  const restored = expandShrunkChoiceFieldsForEditor(existing);
  if (!signFlowFieldsPlacementChanged(existing, restored)) return;

  await patchSignFlowDocument(documentId, {
    fields: normalizeSignFlowFieldRecipientIds(doc, restored),
  });
}

/**
 * Renumber choice labels on save. The compact signer size is applied only when
 * a document is sent, so reopening the editor keeps the boxes you placed.
 */
async function normalizeSignFlowChoiceFieldSizes(
  documentId: string,
  doc: Awaited<ReturnType<typeof getSignFlowDocument>>,
): Promise<Awaited<ReturnType<typeof getSignFlowDocument>>> {
  const existing = (doc.fields ?? []) as SignFlowField[];
  const normalized = normalizeSignFlowChoiceFieldOptionNumbers(existing);
  if (!signFlowFieldsPlacementChanged(existing, normalized)) return doc;

  await patchSignFlowDocument(documentId, {
    fields: normalizeSignFlowFieldRecipientIds(doc, normalized),
  });
  return { ...doc, fields: normalized };
}

export async function completeDealEsignSignflowTemplate(params: {
  dealId: string;
  fileId: string;
  signflowDocumentId: string;
  title?: string;
}): Promise<EsignTemplateFileRecord> {
  const state = await getDealEsignTemplatesState(params.dealId);
  const file = findEsignTemplateFile(state, params.fileId);
  if (!file) throw new Error("eSign template file not found");

  const documentId = params.signflowDocumentId.trim();
  if (!documentId) throw new Error("signflowDocumentId is required");

  let doc = await getSignFlowDocument(documentId);
  const hasFields = (doc.fields?.length ?? 0) > 0;
  if (!hasFields) {
    throw new Error(
      "Add at least one signature field in the SignFlow editor before saving this template.",
    );
  }

  doc = await normalizeSignFlowChoiceFieldSizes(documentId, doc);

  file.signflowDocumentId = documentId;
  file.signflowStatus = "ready";
  file.signflowSavedAt = new Date().toISOString();
  file.esignProvider = "signflow";
  const captured = await captureSignFlowTemplateFieldsForStorage(
    params.dealId,
    file,
    doc,
  );
  const withBindings = applySignflowInvestorDataFieldBindings(
    captured,
    file.signflowInvestorDataFieldBindings,
  );
  file.signflowTemplateFields = withBindings;
  file.signflowInvestorDataFieldBindings = withBindings
    .filter((field) => Boolean(field.dataKey?.trim()))
    .map((field) => ({
      dataKey: String(field.dataKey).trim(),
      esignLabel: String(field.label ?? "").trim() || "Field",
      profileTypes: (field.profileTypes?.length
        ? field.profileTypes
        : ALL_SIGNFLOW_PROFILE_TYPES) as string[],
      page: resolveSignFlowFieldTemplateAnchor(field).templatePage,
      x: Number(field.x) || 0,
      y: Number(field.y) || 0,
      required: field.required !== false,
    }));
  if (params.title?.trim()) file.signflowTitle = params.title.trim();

  const inferred = inferSigningWorkflowFromSignFlowDocument(doc);
  if (inferred.workflowType) {
    file.signflowWorkflowType = inferred.workflowType;
  }
  if (inferred.signingOrder) {
    file.signflowSigningOrder = inferred.signingOrder;
  }

  await persistEsignTemplatesJson(params.dealId, state);
  return file;
}

/**
 * Copy the live SignFlow layout into the deal snapshot when the editor closes.
 * Does not mark the template ready. An empty layout is stored so deleted
 * fields are not restored the next time the editor opens.
 */
export async function syncDealEsignSignflowTemplateFields(params: {
  dealId: string;
  fileId: string;
}): Promise<{ fieldCount: number }> {
  const state = await getDealEsignTemplatesState(params.dealId);
  const file = findEsignTemplateFile(state, params.fileId);
  if (!file) throw new Error("eSign template file not found");

  const documentId = file.signflowDocumentId?.trim() ?? "";
  if (!documentId) {
    throw new Error("Open the SignFlow template editor before saving fields");
  }

  let doc = await getSignFlowDocument(documentId);
  doc = await normalizeSignFlowChoiceFieldSizes(documentId, doc);

  let captured: SignFlowField[];
  try {
    captured = await captureSignFlowTemplateFieldsForStorage(
      params.dealId,
      file,
      doc,
    );
  } catch (err) {
    if (!isMissingTemplatePdfError(err)) throw err;
    captured = normalizeSignFlowFieldRecipientIds(
      doc,
      (doc.fields ?? []) as SignFlowField[],
    ) as SignFlowField[];
  }

  const withBindings = applySignflowInvestorDataFieldBindings(
    captured,
    file.signflowInvestorDataFieldBindings,
  );
  file.signflowTemplateFields = withBindings;
  file.signflowInvestorDataFieldBindings = withBindings
    .filter((field) => Boolean(field.dataKey?.trim()))
    .map((field) => ({
      dataKey: String(field.dataKey).trim(),
      esignLabel: String(field.label ?? "").trim() || "Field",
      profileTypes: (field.profileTypes?.length
        ? field.profileTypes
        : ALL_SIGNFLOW_PROFILE_TYPES) as string[],
      page: resolveSignFlowFieldTemplateAnchor(field).templatePage,
      x: Number(field.x) || 0,
      y: Number(field.y) || 0,
      required: field.required !== false,
    }));

  await persistEsignTemplatesJson(params.dealId, state);
  return { fieldCount: withBindings.length };
}

function resolveRequestedSignFlowProfileTypes(
  profileIds: string[] | undefined,
): SignFlowProfileType[] {
  const unique = new Set<SignFlowProfileType>();
  for (const raw of profileIds ?? []) {
    const mapped = portalProfileIdToSignFlowProfileType(raw);
    if (mapped) unique.add(mapped);
  }
  // No selection (or all cleared upstream) → field applies to every profile.
  if (unique.size === 0) return [...ALL_SIGNFLOW_PROFILE_TYPES];
  return [...unique];
}

function placementKey(page: number, x: number, y: number, label: string): string {
  return [
    Math.max(1, Math.floor(page) || 1),
    Math.round(Number(x) * 10) / 10,
    Math.round(Number(y) * 10) / 10,
    String(label ?? "").trim().toLowerCase(),
  ].join("|");
}

function bindingMatchesField(
  binding: SignflowInvestorDataFieldBinding,
  field: SignFlowField,
): boolean {
  return (
    placementKey(binding.page, binding.x, binding.y, binding.esignLabel) ===
    placementKey(
      Number(field.templatePage ?? field.page) || 1,
      Number(field.x) || 0,
      Number(field.y) || 0,
      String(field.label ?? ""),
    )
  );
}

/** Re-apply SynX bindings so profile scope + dataKey survive SignFlow embed saves. */
export function applySignflowInvestorDataFieldBindings(
  fields: SignFlowField[],
  bindings: SignflowInvestorDataFieldBinding[] | undefined,
): SignFlowField[] {
  return fields.map((field) => {
    const match =
      bindings?.find((binding) => bindingMatchesField(binding, field)) ??
      bindings?.find((binding) => {
        const fieldDataKey =
          field.dataKey?.trim() ||
          ESIGN_LABEL_TO_PROFILE_KEY[
            normalizeEsignFieldLabel(String(field.label ?? ""))
          ];
        if (fieldDataKey && binding.dataKey === fieldDataKey) return true;
        return (
          binding.esignLabel.trim().toLowerCase() ===
          String(field.label ?? "").trim().toLowerCase()
        );
      });

    const dataKey =
      field.dataKey?.trim() ||
      match?.dataKey?.trim() ||
      ESIGN_LABEL_TO_PROFILE_KEY[
        normalizeEsignFieldLabel(String(field.label ?? ""))
      ] ||
      undefined;

    const profileTypes =
      field.profileTypes?.length
        ? field.profileTypes
        : match?.profileTypes?.length
          ? (match.profileTypes as SignFlowProfileType[])
          : undefined;

    const required = resolveBoundInvestorDataFieldRequired(field, match, dataKey);

    return {
      ...field,
      ...(dataKey ? { dataKey } : {}),
      ...(profileTypes?.length ? { profileTypes } : {}),
      ...(required === undefined ? {} : { required }),
    };
  });
}

/** Catalog fields stay required unless the sponsor marked that placement optional. */
function resolveBoundInvestorDataFieldRequired(
  field: SignFlowField,
  match: SignflowInvestorDataFieldBinding | undefined,
  dataKey: string | undefined,
): boolean | undefined {
  if (!dataKey && !match) return undefined;
  if (match && typeof match.required === "boolean") return match.required;
  if (field.required === false) return false;
  return true;
}

/**
 * Append an investor data text/date field to the SignFlow draft so the sponsor
 * can place auto-fill fields while configuring the template.
 */
export async function addDealEsignSignflowInvestorDataField(params: {
  dealId: string;
  fileId: string;
  fieldKey: string;
  /** Portal profile ids (individual, joint_tenancy, …). Empty = all profiles. */
  profileIds?: string[];
  /** 1-based SignFlow builder page where the field should be appended. */
  page?: number;
  /** When false, investors may leave the field blank. Defaults to required. */
  required?: boolean;
}): Promise<{
  field: SignFlowField;
  fieldCount: number;
  esignLabel: string;
  label: string;
}> {
  const state = await getDealEsignTemplatesState(params.dealId);
  const file = findEsignTemplateFile(state, params.fileId);
  if (!file) throw new Error("eSign template file not found");

  const documentId = file.signflowDocumentId?.trim();
  if (!documentId) {
    throw new Error("Open the SignFlow template editor before adding fields");
  }

  const catalog = getEsignInvestorDataField(params.fieldKey);
  if (!catalog) {
    throw new Error("Unknown investor data field");
  }

  const requestedTypes = resolveRequestedSignFlowProfileTypes(params.profileIds);
  if ((params.profileIds?.length ?? 0) > 0) {
    const mappedOnly = new Set<SignFlowProfileType>();
    for (const raw of params.profileIds ?? []) {
      const mapped = portalProfileIdToSignFlowProfileType(raw);
      if (mapped) mappedOnly.add(mapped);
    }
    if (mappedOnly.size === 0) {
      throw new Error("Select at least one valid investor profile");
    }
  }
  const profileTypes = requestedTypes;
  const required = params.required !== false;

  const doc = await getSignFlowDocument(documentId);
  const existing = (doc.fields ?? []) as SignFlowField[];
  const investorRecipientId = resolveSignFlowInvestorRecipientId(doc);
  const targetPage = Math.max(
    1,
    Math.min(
      Math.floor(Number(params.page) || 1),
      Math.max(1, Math.floor(Number(doc.pages) || 1)),
    ),
  );

  let maxY = 18;
  for (const field of existing) {
    const page = Math.max(1, Math.floor(Number(field.page) || 1));
    if (page !== targetPage) continue;
    const y = Number(field.y) || 0;
    const h = Number(field.height) || 0;
    maxY = Math.max(maxY, y + h);
  }

  const isSignature = catalog.signFlowType === "signature";
  const textSize = esignDocumentAlignedTextFieldSize(
    catalog.signFlowType === "date" ? "date" : "text",
  );
  const nextField: SignFlowField = {
    type: catalog.signFlowType,
    label: catalog.esignLabel,
    x: 12,
    y: Math.min(88, maxY + 3),
    width: isSignature ? 18 : textSize.width,
    height: isSignature ? 4 : textSize.height,
    page: targetPage,
    recipientId: investorRecipientId,
    required,
    dataKey: catalog.key,
    profileTypes,
  };

  const toAppend: SignFlowField[] = [nextField];

  const merged = normalizeSignFlowFieldRecipientIds(doc, [
    ...existing,
    ...toAppend,
  ]) as SignFlowField[];

  await patchSignFlowDocument(documentId, { fields: merged });

  const binding: SignflowInvestorDataFieldBinding = {
    dataKey: catalog.key,
    esignLabel: catalog.esignLabel,
    profileTypes,
    page: nextField.page,
    x: nextField.x,
    y: nextField.y,
    required,
  };
  file.signflowInvestorDataFieldBindings = [
    ...(file.signflowInvestorDataFieldBindings ?? []),
    binding,
  ];
  // Keep the saved snapshot in sync so investors see new fields even before
  // the sponsor clicks Save template again.
  file.signflowTemplateFields = applySignflowInvestorDataFieldBindings(
    merged.map((field) => ({
      ...field,
      ...resolveSignFlowFieldTemplateAnchor(field),
    })),
    file.signflowInvestorDataFieldBindings,
  );
  await persistEsignTemplatesJson(params.dealId, state);

  return {
    field: nextField,
    fieldCount: merged.length,
    esignLabel: nextField.label,
    label: catalog.label,
  };
}
