import {
  getSignFlowConfig,
  requireSignFlowConfig,
} from "../../config/signflow.config.js";
import {
  isEsignProviderUnreachableError,
} from "./esignProviderErrors.js";
import {
  DEFAULT_ESIGN_SIGNFLOW_WORKFLOW_TYPE,
} from "../../constants/esignSigningWorkflow.js";
import {
  signFlowFieldAppliesToProfile,
  type SignFlowProfileType,
} from "../../constants/esignProfileTypes.js";
import { PDFDocument } from "pdf-lib";

type SignFlowErrorBody = {
  error?: {
    message?: string;
    code?: string;
  };
};

function buildUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl.replace(/\/$/, "")}${normalizedPath}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseSignFlowError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as SignFlowErrorBody;
    const msg = body.error?.message?.trim();
    const code = body.error?.code?.trim();
    if (res.status === 401) {
      return (
        msg ||
        "SignFlow API key is invalid. Copy an API key from SignFlow → API Keys and set SIGNFLOW_API_KEY in backend/.env.local."
      );
    }
    if (res.status === 429) {
      return (
        msg ||
        "SignFlow is temporarily busy (rate limit). Wait a moment and try again."
      );
    }
    if (res.status === 404) {
      return (
        msg ||
        "SignFlow document not found. Ask your sponsor to resend the eSign request."
      );
    }
    if (msg && code) return `${code}: ${msg}`;
    if (msg) return msg;
  } catch {
    /* ignore */
  }
  return `SignFlow API error (${res.status})`;
}

/**
 * Reusable SignFlow HTTP client — see API_INTEGRATION.md Step 3.
 * Auth: Authorization: Bearer {SIGNFLOW_API_KEY}
 */
export async function signflowRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
  attempt = 0,
): Promise<T | null> {
  const { baseUrl, apiKey } = requireSignFlowConfig();
  const url = buildUrl(baseUrl, path);

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err) {
    if (isEsignProviderUnreachableError(err)) {
      throw new Error(
        `SignFlow API is not reachable at ${baseUrl}. Start the SignFlow backend on port 5007 and try again.`,
        { cause: err },
      );
    }
    throw err;
  }

  if (response.status === 429 && attempt < 3) {
    await sleepMs(400 * (attempt + 1));
    return signflowRequest<T>(path, options, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(await parseSignFlowError(response));
  }

  if (response.status === 204) return null;
  return (await response.json()) as T;
}

/** GET /health — no auth required per API_INTEGRATION.md. */
export async function checkSignFlowHealth(): Promise<{ status: string }> {
  const cfg = getSignFlowConfig();
  if (!cfg) {
    throw new Error("SignFlow is not configured");
  }

  const res = await fetch(buildUrl(cfg.baseUrl, "/health"));
  if (!res.ok) {
    throw new Error(`SignFlow health check failed (${res.status})`);
  }
  return (await res.json()) as { status: string };
}

/** Count pages in a PDF buffer (for SignFlow document metadata). */
export async function countSignFlowPdfPages(pdfBuffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  return Math.max(1, doc.getPageCount());
}

/** Verifies API key by calling GET /documents. */
export async function verifySignFlowConnection(): Promise<{
  healthy: boolean;
  documentCount: number;
}> {
  await checkSignFlowHealth();
  const documents = await signflowRequest<unknown[]>("/documents");
  return {
    healthy: true,
    documentCount: Array.isArray(documents) ? documents.length : 0,
  };
}

export type SignFlowRecipient = {
  id: string;
  name: string;
  email: string;
  role: string;
  color?: string;
  order?: number;
  profileType?: SignFlowProfileType;
};

export type SignFlowField = {
  type: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
  recipientId: string;
  required?: boolean;
  profileType?: SignFlowProfileType;
  profileTypes?: SignFlowProfileType[];
  /**
   * Catalog key for sponsor-added investor data fields (e.g. firstName).
   * Used to prefill from the investor profile when the label alone is ambiguous.
   */
  dataKey?: string;
  /** Pre-filled value for text/date fields when sending for signing. */
  value?: string;
  /** Sponsor template page (1-based) where the field was placed. */
  templatePage?: number;
  /** Content hash of the template page — anchors coordinates after PDF merges. */
  pageHash?: string;
  /** Radios that share this id are one group. A newly placed radio has its own id. */
  radioGroupId?: string;
};

export type SendSignFlowDocumentParams = {
  title: string;
  pdfBuffer: Buffer;
  fileName?: string;
  recipients: SignFlowRecipient[];
  fields: SignFlowField[];
  emailSubject?: string;
  emailMessage?: string;
  workflowType?: "parallel" | "sequential";
};

/** Create document with PDF, configure recipients/fields, and send — API_INTEGRATION.md Step 5. */
export async function sendSignFlowDocumentForSigning(
  params: SendSignFlowDocumentParams,
): Promise<{ documentId: string }> {
  const { baseUrl, apiKey } = requireSignFlowConfig();

  const form = new FormData();
  form.append("title", params.title);
  const pageCount = await countSignFlowPdfPages(params.pdfBuffer);
  form.append("pages", String(pageCount));
  const blob = new Blob([new Uint8Array(params.pdfBuffer)], {
    type: "application/pdf",
  });
  form.append("file", blob, params.fileName?.trim() || "document.pdf");

  const createRes = await fetch(buildUrl(baseUrl, "/documents"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!createRes.ok) {
    throw new Error(await parseSignFlowError(createRes));
  }

  const doc = (await createRes.json()) as { id?: string };
  const documentId = doc.id?.trim();
  if (!documentId) {
    throw new Error("SignFlow returned an incomplete document create response");
  }

  await signflowRequest(`/documents/${encodeURIComponent(documentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipients: params.recipients,
      fields: normalizeSignFlowFieldsForApi(params.fields),
      workflowType: params.workflowType ?? DEFAULT_ESIGN_SIGNFLOW_WORKFLOW_TYPE,
      emailSubject: params.emailSubject,
      emailMessage: params.emailMessage,
      status: "sent",
    }),
  });

  return { documentId };
}

export type SignFlowDocument = {
  id: string;
  title?: string;
  status?: string;
  pages?: number;
  fileUrl?: string;
  workflowType?: "parallel" | "sequential";
  recipients?: Array<{
    id?: string;
    name?: string;
    email?: string;
    role?: string;
    color?: string;
    order?: number;
    profileType?: string;
    signingStatus?: string;
    signed?: boolean;
    signedAt?: string;
  }>;
  fields?: Array<{
    id?: string;
    type?: string;
    label?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    page?: number;
    recipientId?: string;
    required?: boolean;
    profileType?: string;
    profileTypes?: string[];
    dataKey?: string;
    value?: string;
    templatePage?: number;
    pageHash?: string;
    radioGroupId?: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
};

export async function getSignFlowDocument(
  documentId: string,
): Promise<SignFlowDocument> {
  const doc = await signflowRequest<SignFlowDocument>(
    `/documents/${encodeURIComponent(documentId.trim())}`,
  );
  if (!doc?.id) {
    throw new Error("SignFlow returned an incomplete document response");
  }
  return doc;
}

/**
 * Reconcile SignFlow signing_sessions with investor field values so sponsor
 * counter-sign can open after the portal recorded investor completion.
 */
export async function ensureSignFlowInvestorPhaseRecorded(
  documentId: string,
): Promise<void> {
  const id = documentId.trim();
  if (!id) return;
  try {
    await signflowRequest(
      `/documents/${encodeURIComponent(id)}/embed/ensure-investor-phase`,
      { method: "POST" },
    );
  } catch (err) {
    console.warn("ensureSignFlowInvestorPhaseRecorded:", err);
  }
}

/** Create or reuse a signing session token for embedded investor signing. */
/**
 * Remove the investor signature on a live SignFlow document so they can sign again.
 * SignFlow rejects this after a sponsor signature is stored.
 */
export async function resetSignFlowInvestorSignature(params: {
  documentId: string;
  recipientEmail: string;
  /** Keep answers already entered so the investor can change them. */
  preserveFieldValues?: boolean;
}): Promise<void> {
  const documentId = params.documentId.trim();
  const recipientEmail = params.recipientEmail.trim().toLowerCase();
  if (!documentId) {
    throw new Error("SignFlow documentId is required");
  }
  if (!recipientEmail) {
    throw new Error("recipientEmail is required");
  }

  await signflowRequest(
    `/documents/${encodeURIComponent(documentId)}/embed/reset-investor-signature`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientEmail,
        preserveFieldValues: params.preserveFieldValues === true,
      }),
    },
  );
}

export async function createSignFlowEmbedSigningSession(params: {
  documentId: string;
  recipientEmail?: string;
  recipientId?: string;
  profileType?: string;
}): Promise<{ token: string; signUrl: string }> {
  const documentId = params.documentId.trim();
  if (!documentId) {
    throw new Error("SignFlow documentId is required");
  }

  const body: Record<string, string> = {};
  const email = params.recipientEmail?.trim().toLowerCase();
  const recipientId = params.recipientId?.trim();
  const profileType = params.profileType?.trim();
  if (email) body.recipientEmail = email;
  if (recipientId) body.recipientId = recipientId;
  if (profileType) body.profileType = profileType;
  if (!email && !recipientId) {
    throw new Error("recipientEmail or recipientId is required");
  }

  const result = await signflowRequest<{ token?: string; signUrl?: string }>(
    `/documents/${encodeURIComponent(documentId)}/embed/signing-session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const token = result?.token?.trim();
  if (!token) {
    throw new Error("SignFlow returned an incomplete embed signing session");
  }

  const cfg = requireSignFlowConfig();
  const baseSignUrl =
    result?.signUrl?.trim() || buildSignFlowSignerEmbedUrl(token);

  return {
    token,
    signUrl: enrichSignFlowEmbedSignUrl(baseSignUrl, cfg.embedApiKey),
  };
}

function isSignFlowWaitingForPriorSignerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("WAITING_FOR_PRIOR_SIGNER") ||
    message.toLowerCase().includes("investor must sign") ||
    message.toLowerCase().includes("must sign first") ||
    message.toLowerCase().includes("prior signer")
  );
}

export function mapSignFlowEmbedSessionError(
  err: unknown,
  baseUrl?: string | null,
): {
  code: "not_configured" | "not_pending" | "waiting_for_prior_signer";
  message: string;
  waitingFor?: "sponsor" | "investor" | "prior_investor";
} {
  const message =
    err instanceof Error ? err.message.trim() : String(err ?? "").trim();

  if (isSignFlowWaitingForPriorSignerError(err)) {
    const waitingFor: "sponsor" | "investor" | "prior_investor" =
      message.toLowerCase().includes("sponsor") ? "sponsor" : "prior_investor";
    return {
      code: "waiting_for_prior_signer",
      message:
        message ||
        "The other party on this document must sign first.",
      waitingFor,
    };
  }

  if (isEsignProviderUnreachableError(err)) {
    const url = baseUrl?.trim() || "SIGNFLOW_API_BASE_URL";
    return {
      code: "not_configured",
      message: `SignFlow API is not reachable at ${url}. Start the SignFlow backend on port 5007 and the SignFlow UI on port 5177, then try again.`,
    };
  }

  if (
    message.includes("429") ||
    message.toLowerCase().includes("rate limit") ||
    message.toLowerCase().includes("temporarily busy")
  ) {
    return {
      code: "not_configured",
      message:
        "SignFlow is temporarily busy. Wait a few seconds and click Try again.",
    };
  }

  if (message) {
    return {
      code: "not_pending",
      message: message.includes("SignFlow")
        ? message
        : `SignFlow signing error: ${message}`,
    };
  }

  return {
    code: "not_pending",
    message:
      "Could not open SignFlow signing. Confirm SignFlow is running on port 5007 and the SignFlow UI on port 5177, then try again.",
  };
}

/**
 * Sponsor embed session — reconciles investor phase first (and retries once) when
 * the portal already recorded investor completion for this profile send.
 */
export async function createSignFlowSponsorEmbedSigningSession(params: {
  documentId: string;
  recipientEmail?: string;
  recipientId?: string;
  investorPhaseComplete?: boolean;
}): Promise<{ token: string; signUrl: string }> {
  const run = async () => {
    if (params.investorPhaseComplete) {
      await ensureSignFlowInvestorPhaseRecorded(params.documentId);
    }
    return createSignFlowEmbedSigningSession({
      documentId: params.documentId,
      recipientEmail: params.recipientEmail,
      recipientId: params.recipientId,
    });
  };

  try {
    return await run();
  } catch (err) {
    if (!params.investorPhaseComplete || !isSignFlowWaitingForPriorSignerError(err)) {
      throw err;
    }
    await ensureSignFlowInvestorPhaseRecorded(params.documentId);
    return await run();
  }
}

/** Stable embed recipient ids — must match SignFlow `EMBED_DEFAULT_RECIPIENTS`. */
export const SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID = "rec_investor";
export const SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID = "rec_sponsor";
/** Generic template sponsor. Any deal sponsor may claim this slot until one has signed. */
export const SIGNFLOW_OPEN_SPONSOR_RECIPIENT_ID = "rec_sponsor_open";
export const SIGNFLOW_OPEN_SPONSOR_NAME = "Anyone can sign";
export const SIGNFLOW_OPEN_SPONSOR_EMAIL = "sponsor@embed.local";
/** Kept on the sent copy so the slot stays open after a sponsor's name is filled in. */
export const SIGNFLOW_OPEN_SPONSOR_ROLE = "open-sponsor";
/** Invisible suffix so a claimed slot stays open until that sponsor signs. */
const SIGNFLOW_OPEN_SPONSOR_MARK = "\u2060";

export function signFlowOpenSponsorSignerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes(SIGNFLOW_OPEN_SPONSOR_MARK)) return trimmed;
  return `${trimmed}${SIGNFLOW_OPEN_SPONSOR_MARK}`;
}
/**
 * Holds alternate signature lines (an "OR" block) that are not this signer's.
 * Not a real recipient, so SignFlow does not ask anyone to sign those lines.
 */
export const SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID = "rec_alternate_signature";

export function resolveSignFlowInvestorRecipientId(doc: SignFlowDocument): string {
  const recipients = doc.recipients ?? [];
  const buyer = recipients.find(
    (r) => String(r.role ?? "").trim().toLowerCase() === "buyer",
  );
  const byClientId = recipients.find(
    (r) => r.id?.trim() === SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID,
  );
  return (
    buyer?.id?.trim() ||
    byClientId?.id?.trim() ||
    SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID
  );
}

export function resolveSignFlowSponsorRecipientId(doc: SignFlowDocument): string {
  const recipients = doc.recipients ?? [];
  const seller = recipients.find((r) => matchSignFlowPartyRole(r, "sponsor"));
  const byClientId = recipients.find(
    (r) => r.id?.trim() === SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID,
  );
  return (
    seller?.id?.trim() ||
    byClientId?.id?.trim() ||
    SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID
  );
}

type SignFlowDocumentField = NonNullable<SignFlowDocument["fields"]>[number];

/** Map field recipient ids to the document's current recipient UUIDs (fields-only PATCH). */
export function normalizeSignFlowFieldRecipientIds(
  doc: SignFlowDocument,
  fields: SignFlowDocumentField[],
): SignFlowDocumentField[] {
  const recipients = doc.recipients ?? [];
  const recipientIds = new Set(
    recipients.map((r) => r.id?.trim()).filter(Boolean) as string[],
  );
  const investorId = resolveSignFlowInvestorRecipientId(doc);
  const sponsorId = resolveSignFlowSponsorRecipientId(doc);

  return fields.map((field) => {
    const rid = String(field.recipientId ?? "").trim();
    if (recipientIds.has(rid)) {
      return field;
    }
    if (
      rid === SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID ||
      rid === "rec_1"
    ) {
      return { ...field, recipientId: investorId };
    }
    if (
      rid === SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID ||
      rid === "rec_2"
    ) {
      return { ...field, recipientId: sponsorId };
    }
    if (rid === SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID) {
      return field;
    }
    return { ...field, recipientId: investorId };
  });
}

/** Creates a draft SignFlow document from a PDF (template editor setup). */
const EMBED_TEMPLATE_RECIPIENTS = [
  {
    id: SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID,
    name: "Investor",
    email: "investor@embed.local",
    role: "buyer",
    color: "#dc2626",
    order: 1,
  },
  {
    id: SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID,
    name: SIGNFLOW_OPEN_SPONSOR_NAME,
    email: SIGNFLOW_OPEN_SPONSOR_EMAIL,
    role: "seller",
    color: "#2563eb",
    order: 2,
  },
] as const;

export async function createSignFlowDraftFromPdf(params: {
  title: string;
  pdfBuffer: Buffer;
  fileName?: string;
  pages?: number;
}): Promise<{ documentId: string }> {
  const { baseUrl, apiKey } = requireSignFlowConfig();

  const form = new FormData();
  form.append("title", params.title.trim());
  form.append("pages", String(Math.max(1, params.pages ?? 1)));
  const blob = new Blob([new Uint8Array(params.pdfBuffer)], {
    type: "application/pdf",
  });
  form.append("file", blob, params.fileName?.trim() || "template.pdf");

  const createRes = await fetch(buildUrl(baseUrl, "/documents"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!createRes.ok) {
    throw new Error(await parseSignFlowError(createRes));
  }

  const doc = (await createRes.json()) as { id?: string };
  const documentId = doc.id?.trim();
  if (!documentId) {
    throw new Error("SignFlow returned an incomplete document create response");
  }

  await patchSignFlowDocument(documentId, {
    recipients: [...EMBED_TEMPLATE_RECIPIENTS],
  });

  return { documentId };
}

/** Pre-seed investor/sponsor recipients so embed builder opens ready to place fields. */
export async function ensureSignFlowEmbedRecipients(documentId: string): Promise<void> {
  const doc = await getSignFlowDocument(documentId);
  const existing = doc.recipients ?? [];
  const fields = doc.fields ?? [];

  const existingBuyer = existing.find(
    (r) => String(r.role ?? "").trim().toLowerCase() === "buyer",
  );
  const existingSeller = existing.find(
    (r) => String(r.role ?? "").trim().toLowerCase() === "seller",
  );

  const oldBuyerId = existingBuyer?.id?.trim() ?? "";
  const oldSellerId = existingSeller?.id?.trim() ?? "";

  const nextRecipients: SignFlowRecipient[] = [
    {
      id: SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID,
      name: existingBuyer?.name?.trim() || EMBED_TEMPLATE_RECIPIENTS[0].name,
      email: existingBuyer?.email?.trim() || EMBED_TEMPLATE_RECIPIENTS[0].email,
      role: "buyer",
      color: existingBuyer?.color ?? EMBED_TEMPLATE_RECIPIENTS[0].color,
      order: existingBuyer?.order ?? EMBED_TEMPLATE_RECIPIENTS[0].order,
    },
    {
      id: SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID,
      name: openSponsorDisplayName(existingSeller?.name),
      email: existingSeller?.email?.trim() || EMBED_TEMPLATE_RECIPIENTS[1].email,
      role: "seller",
      color: existingSeller?.color ?? EMBED_TEMPLATE_RECIPIENTS[1].color,
      order: existingSeller?.order ?? EMBED_TEMPLATE_RECIPIENTS[1].order,
    },
  ];

  const nextFields = fields.map((field) => {
    const rid = String(field.recipientId ?? "").trim();
    const recipient = existing.find((item) => item.id?.trim() === rid);
    const role = String(recipient?.role ?? "").trim().toLowerCase();
    if (
      rid === oldBuyerId ||
      rid === SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID ||
      role === "buyer"
    ) {
      return { ...field, recipientId: SIGNFLOW_EMBED_INVESTOR_RECIPIENT_ID };
    }
    if (
      rid === oldSellerId ||
      rid === SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID ||
      role === "seller"
    ) {
      return { ...field, recipientId: SIGNFLOW_EMBED_SPONSOR_RECIPIENT_ID };
    }
    return field;
  });

  // Buyer and seller rows already exist. Replacing them deletes every field
  // (recipient delete cascades to document_fields). Leave this document alone.
  if (existingBuyer && existingSeller) return;

  const docForFieldNormalization: SignFlowDocument = {
    ...doc,
    recipients: nextRecipients,
  };
  const normalizedFields = normalizeSignFlowFieldRecipientIds(
    docForFieldNormalization,
    nextFields,
  );

  await patchSignFlowDocument(documentId, {
    recipients: nextRecipients,
    fields: normalizedFields,
  });
}

export function buildSignFlowEditorUrl(documentId: string): string {
  const cfg = requireSignFlowConfig();
  const id = encodeURIComponent(documentId.trim());
  const base = `${cfg.appBaseUrl}/embed/documents/${id}/builder`;
  if (!cfg.embedApiKey) return base;
  const params = new URLSearchParams({ apiKey: cfg.embedApiKey });
  return `${base}?${params.toString()}`;
}

export function buildSignFlowSignerEmbedUrl(signingToken: string): string {
  const { appBaseUrl } = requireSignFlowConfig();
  return `${appBaseUrl}/embed/sign/${encodeURIComponent(signingToken.trim())}`;
}

/** Adds embed apiKey to SignFlow signer iframe URLs when configured. */
export function enrichSignFlowEmbedSignUrl(
  signUrl: string,
  embedApiKey?: string | null,
): string {
  const raw = signUrl.trim();
  if (!raw) return raw;
  const key = embedApiKey?.trim();
  if (!key) return raw;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("apiKey")) {
      u.searchParams.set("apiKey", key);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Template page + page anchor for a field read back from a SignFlow document.
 *
 * SignFlow echoes the `templatePage`/`pageHash` annotations we patched earlier,
 * so they still describe the old page after the sponsor drags a field to another
 * page in the embed. The live `page` is the only trustworthy placement; a moved
 * field's anchor hash is dropped so it gets re-derived from the current page.
 */
export function resolveSignFlowFieldTemplateAnchor(field: {
  page?: number;
  templatePage?: number;
  pageHash?: string;
}): { templatePage: number; pageHash: string | undefined } {
  const livePage = Math.floor(Number(field.page));
  const storedPage = Math.floor(Number(field.templatePage));
  const templatePage =
    Number.isFinite(livePage) && livePage >= 1
      ? livePage
      : Number.isFinite(storedPage) && storedPage >= 1
        ? storedPage
        : 1;

  const moved =
    Number.isFinite(storedPage) && storedPage >= 1 && storedPage !== templatePage;
  const pageHash = field.pageHash?.trim();

  return {
    templatePage,
    pageHash: pageHash && !moved ? pageHash : undefined,
  };
}

/** Shifts page numbers when answer pages are prepended; x/y/width/height stay as placed. */
export function shiftSignFlowFieldsPageOffset(
  fields: SignFlowField[],
  pageOffset: number,
): SignFlowField[] {
  const offset = Math.max(0, Math.floor(pageOffset));
  if (offset === 0) return fields;
  return fields.map((field) => ({
    ...field,
    page: Math.max(1, Math.floor(field.page) + offset),
  }));
}

function signFlowFieldCoordinate(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** SignFlow signing API expects `date_signed` (embed builder may emit `date`). */
export function normalizeSignFlowFieldTypeForApi(type: string): string {
  const t = String(type ?? "").trim().toLowerCase();
  if (t === "date") return "date_signed";
  return String(type ?? "text").trim() || "text";
}

export function normalizeSignFlowFieldsForApi<T extends { type?: string }>(
  fields: T[],
): Array<T & { type: string }> {
  return fields.map((field) => ({
    ...field,
    type: normalizeSignFlowFieldTypeForApi(String(field.type ?? "text")),
  }));
}

/**
 * Resolve template fields for send/sign.
 * The live SignFlow document is the layout the sponsor last left in the editor.
 * Saved snapshots are not copied back, or removed fields show up again.
 */
export function resolveSignFlowTemplateDocumentFields(
  _file: {
    signflowStatus?: string;
    signflowTemplateFields?: SignFlowField[];
    signflowInvestorDataFieldBindings?: Array<{
      dataKey?: string;
      esignLabel?: string;
      page?: number;
      x?: number;
      y?: number;
    }>;
  },
  templateDoc: SignFlowDocument,
): SignFlowDocument {
  return templateDoc;
}

export function findSignFlowTemplateRecipient(
  template: SignFlowDocument,
  roleKeys: string[],
): (NonNullable<SignFlowDocument["recipients"]>[number] & { id?: string }) | undefined {
  const keys = new Set(roleKeys.map((k) => k.toLowerCase()));
  return (template.recipients ?? []).find((r) => {
    const role = String(r.role ?? "").trim().toLowerCase();
    const id = String(r.id ?? "").trim().toLowerCase();
    return (
      keys.has(role) ||
      keys.has(id) ||
      (keys.has("buyer") && (role.includes("investor") || role.includes("buyer"))) ||
      (keys.has("seller") && (role.includes("sponsor") || role.includes("seller")))
    );
  });
}

const SPONSOR_SIGNING_FIELD_TYPES = new Set([
  "signature",
  "initials",
  "initial",
  "date_signed",
  "date",
  "stamp",
]);

function isSponsorSigningFieldType(type: string): boolean {
  const t = type.trim().toLowerCase();
  if (!t) return false;
  if (SPONSOR_SIGNING_FIELD_TYPES.has(t)) return true;
  return t.includes("sign") || t.includes("initial");
}

function signFlowFieldRecipientParty(
  field: NonNullable<SignFlowDocument["fields"]>[number],
  recipients: NonNullable<SignFlowDocument["recipients"]>,
): "investor" | "sponsor" | null {
  const rid = String(field.recipientId ?? "").trim().toLowerCase();
  if (!rid) return null;

  const matched = recipients.find(
    (r) => String(r.id ?? "").trim().toLowerCase() === rid,
  );
  if (matched) {
    if (matchSignFlowPartyRole(matched, "investor")) return "investor";
    if (matchSignFlowPartyRole(matched, "sponsor")) return "sponsor";
  }

  if (
    rid === "rec_investor" ||
    rid === "rec_1" ||
    rid === "recipient_a" ||
    rid.includes("investor")
  ) {
    return "investor";
  }
  if (
    rid === "rec_sponsor" ||
    rid === "rec_2" ||
    rid === "recipient_b" ||
    rid.includes("sponsor")
  ) {
    return "sponsor";
  }

  return null;
}

export function signFlowAnyInvestorHasSigned(doc: SignFlowDocument): boolean {
  return (doc.recipients ?? [])
    .filter((recipient) => matchSignFlowPartyRole(recipient, "investor"))
    .some(recipientHasSigned);
}

function isInvestorSigningFieldType(type: string): boolean {
  const t = type.trim().toLowerCase();
  if (!t) return false;
  if (
    t === "signature" ||
    t === "initials" ||
    t === "initial" ||
    t === "date_signed" ||
    t === "date"
  ) {
    return true;
  }
  return t.includes("sign") || t.includes("initial");
}

/** True when investor signing fields on the live SignFlow doc have captured values. */
export function signFlowInvestorHasCompletedSigningFields(
  doc: SignFlowDocument,
): boolean {
  const recipients = doc.recipients ?? [];
  const investorFields = (doc.fields ?? []).filter((field) => {
    if (!isInvestorSigningFieldType(String(field.type ?? ""))) return false;
    return signFlowFieldRecipientParty(field, recipients) === "investor";
  });
  if (investorFields.length === 0) return false;
  const required = investorFields.filter((field) => field.required !== false);
  const check = required.length > 0 ? required : investorFields;
  return check.some((field) => Boolean(String(field.value ?? "").trim()));
}

/** Recipient signed and/or investor fields filled on the live SignFlow document. */
export function signFlowInvestorPhaseComplete(doc: SignFlowDocument): boolean {
  return (
    signFlowAnyInvestorHasSigned(doc) ||
    signFlowInvestorHasCompletedSigningFields(doc)
  );
}

/** True when recipient order assigns sponsor a lower order than every investor. */
export function signFlowSponsorSignsBeforeInvestor(
  doc: SignFlowDocument,
): boolean {
  const investors = (doc.recipients ?? []).filter((r) =>
    matchSignFlowPartyRole(r, "investor"),
  );
  const sponsor = (doc.recipients ?? []).find((r) =>
    matchSignFlowPartyRole(r, "sponsor"),
  );
  if (investors.length === 0 || !sponsor) return false;

  const sponsorOrder = Number(sponsor.order) || 2;
  const minInvestorOrder = Math.min(
    ...investors.map((r) => Number(r.order) || 1),
  );
  return sponsorOrder < minInvestorOrder;
}

/** True when recipient order assigns investor before sponsor on this document. */
export function signFlowInvestorSignsBeforeSponsor(
  doc: SignFlowDocument,
): boolean {
  const investors = (doc.recipients ?? []).filter((r) =>
    matchSignFlowPartyRole(r, "investor"),
  );
  const sponsor = (doc.recipients ?? []).find((r) =>
    matchSignFlowPartyRole(r, "sponsor"),
  );
  if (investors.length === 0 || !sponsor) return false;

  const sponsorOrder = Number(sponsor.order) || 2;
  const minInvestorOrder = Math.min(
    ...investors.map((r) => Number(r.order) || 1),
  );
  if (minInvestorOrder < sponsorOrder) {
    const workflowType = String(doc.workflowType ?? "")
      .trim()
      .toLowerCase();
    // Parallel lets either party sign, even when older sends stored different orders.
    return workflowType !== "parallel";
  }
  return false;
}

/** True when sponsor must wait for investor signature (investor-first by order). */
export function signFlowCounterSignRequiresInvestorSigned(
  doc: SignFlowDocument,
): boolean {
  if (signFlowSponsorSignsBeforeInvestor(doc)) return false;
  return signFlowInvestorSignsBeforeSponsor(doc);
}

export function signFlowTemplateHasSponsorFields(
  template: SignFlowDocument,
): boolean {
  const recipients = template.recipients ?? [];
  return (template.fields ?? []).some((field) => {
    if (!isSponsorSigningFieldType(String(field.type ?? ""))) return false;
    return signFlowFieldRecipientParty(field, recipients) === "sponsor";
  });
}

/**
 * Copies all investor-role template fields with exact sponsor placement (x/y/page).
 * Profile visibility is enforced by SignFlow at sign time via recipient.profileType.
 */
export function mapSignFlowTemplateFieldsForInvestor(
  template: SignFlowDocument,
  investorRecipientId: string,
): SignFlowField[] {
  const investorRoleKeys = new Set([
    investorRecipientId,
    "rec_1",
    "buyer",
    "investor",
    "client",
  ]);
  const investorTemplateRecipient =
    findSignFlowTemplateRecipient(template, [
      ...investorRoleKeys,
      "recipient_a",
    ]) ?? template.recipients?.[0];
  const sourceRecipientId = investorTemplateRecipient?.id?.trim() ?? "";
  const recipients = template.recipients ?? [];

  return (template.fields ?? [])
    .filter((f) => {
      const party = signFlowFieldRecipientParty(f, recipients);
      if (party === "sponsor") return false;
      if (party === "investor") return true;
      const rid = String(f.recipientId ?? "").trim();
      if (rid && sourceRecipientId && rid !== sourceRecipientId) {
        return false;
      }
      return true;
    })
    .map((f) => {
      const profileTypes = f.profileTypes?.length
        ? (f.profileTypes as SignFlowProfileType[])
        : undefined;
      const profileType = profileTypes?.length
        ? undefined
        : (f.profileType as SignFlowProfileType | undefined);
      const { templatePage, pageHash } =
        resolveSignFlowFieldTemplateAnchor(f);
      return {
        type: normalizeSignFlowFieldTypeForApi(String(f.type ?? "signature")),
        label: String(f.label ?? "Field"),
        x: signFlowFieldCoordinate(f.x, 10),
        y: signFlowFieldCoordinate(f.y, 10),
        width: Math.max(1, signFlowFieldCoordinate(f.width, 20)),
        height: Math.max(1, signFlowFieldCoordinate(f.height, 4)),
        page: templatePage,
        templatePage,
        ...(pageHash ? { pageHash } : {}),
        ...(f.dataKey?.trim() ? { dataKey: f.dataKey.trim() } : {}),
        ...(f.value?.trim() ? { value: f.value.trim() } : {}),
        recipientId: investorRecipientId,
        required: f.required !== false,
        ...(profileTypes ? { profileTypes } : {}),
        ...(profileType ? { profileType } : {}),
        ...(String(f.radioGroupId ?? "").trim()
          ? { radioGroupId: String(f.radioGroupId).trim() }
          : {}),
      };
    });
}

export function signFlowInvestorTemplateHasFieldsForProfile(
  template: SignFlowDocument,
  profileType: SignFlowProfileType,
): boolean {
  const investorRoleKeys = new Set([
    "rec_investor",
    "rec_1",
    "buyer",
    "investor",
    "client",
    "recipient_a",
  ]);
  const investorTemplateRecipient =
    findSignFlowTemplateRecipient(template, [...investorRoleKeys]) ??
    template.recipients?.[0];
  const sourceRecipientId = investorTemplateRecipient?.id?.trim() ?? "";

  return (template.fields ?? []).some((f) => {
    const rid = String(f.recipientId ?? "").trim();
    if (rid && sourceRecipientId && rid !== sourceRecipientId) {
      return false;
    }
    return signFlowFieldAppliesToProfile(f, profileType);
  });
}

export type SignFlowSponsorSigningGroup = {
  clientRecipientId: string;
  name: string;
  email: string;
  color?: string;
  /** Generic template sponsor. Any deal sponsor may sign; the first signature closes the slot. */
  placeholder: boolean;
  fields: SignFlowField[];
};

/** One signing party per sponsor who has fields on the template. */
export function collectSignFlowSponsorSigningGroups(
  template: SignFlowDocument,
): SignFlowSponsorSigningGroup[] {
  const recipients = template.recipients ?? [];
  const sellers = recipients.filter((recipient) =>
    matchSignFlowPartyRole(recipient, "sponsor"),
  );
  const groups: SignFlowSponsorSigningGroup[] = [];

  sellers.forEach((seller, index) => {
    const sourceId = String(seller.id ?? "").trim();
    if (!sourceId) return;
    const owned = (template.fields ?? []).filter(
      (field) => String(field.recipientId ?? "").trim() === sourceId,
    );
    if (owned.length === 0) return;
    const email = String(seller.email ?? "").trim().toLowerCase();
    const name = String(seller.name ?? "").trim() || email || "Sponsor";
    const clientRecipientId = `rec_sponsor_${index + 1}`;
    groups.push({
      clientRecipientId,
      name,
      email,
      color: seller.color,
      placeholder: isSignFlowOpenSponsorRecipient({
        id: seller.id,
        email,
        name,
        role: seller.role,
      }),
      fields: owned.map((field) => {
        const { templatePage, pageHash } = resolveSignFlowFieldTemplateAnchor(field);
        return {
          type: String(field.type ?? "signature"),
          label: String(field.label ?? "Field"),
          x: signFlowFieldCoordinate(field.x, 10),
          y: signFlowFieldCoordinate(field.y, 10),
          width: Math.max(1, signFlowFieldCoordinate(field.width, 20)),
          height: Math.max(1, signFlowFieldCoordinate(field.height, 4)),
          page: templatePage,
          templatePage,
          ...(pageHash ? { pageHash } : {}),
          recipientId: clientRecipientId,
          required: field.required !== false,
          ...(String(field.radioGroupId ?? "").trim()
            ? { radioGroupId: String(field.radioGroupId).trim() }
            : {}),
        };
      }),
    });
  });

  return groups;
}

export function mapSignFlowTemplateFieldsForSponsor(
  template: SignFlowDocument,
  sponsorRecipientId: string,
): SignFlowField[] {
  const sponsorRoleKeys = new Set([
    sponsorRecipientId,
    "rec_2",
    "seller",
    "sponsor",
    "recipient_b",
  ]);
  const sponsorTemplateRecipient =
    findSignFlowTemplateRecipient(template, [...sponsorRoleKeys]) ??
    template.recipients?.[1];
  const sourceRecipientId = sponsorTemplateRecipient?.id?.trim() ?? "";

  return (template.fields ?? [])
    .filter((f) => {
      const rid = String(f.recipientId ?? "").trim();
      if (rid && sourceRecipientId && rid !== sourceRecipientId) {
        return false;
      }
      return true;
    })
    .map((f) => {
      const { templatePage, pageHash } =
        resolveSignFlowFieldTemplateAnchor(f);
      return {
        type: String(f.type ?? "signature"),
        label: String(f.label ?? "Field"),
        x: signFlowFieldCoordinate(f.x, 10),
        y: signFlowFieldCoordinate(f.y, 10),
        width: Math.max(1, signFlowFieldCoordinate(f.width, 20)),
        height: Math.max(1, signFlowFieldCoordinate(f.height, 4)),
        page: templatePage,
        templatePage,
        ...(pageHash ? { pageHash } : {}),
        recipientId: sponsorRecipientId,
        required: f.required !== false,
        ...(String(f.radioGroupId ?? "").trim()
          ? { radioGroupId: String(f.radioGroupId).trim() }
          : {}),
      };
    });
}

export type SignFlowRecipientSignAccess =
  | { allowed: true }
  | {
      allowed: false;
      code: "waiting_for_prior_signer";
      waitingFor: "sponsor" | "investor";
      message: string;
    };

export function signFlowRecipientHasSigned(recipient: {
  signed?: boolean;
  signingStatus?: string;
  status?: string;
  signedAt?: string | null;
}): boolean {
  const status = String(recipient.signingStatus ?? recipient.status ?? "")
    .trim()
    .toLowerCase();
  if (status === "signed" || status === "completed") return true;
  if (recipient.signed === true) return true;
  // A pending recipient can still carry a timestamp from an earlier view.
  if (recipient.signed === false) return false;
  return Boolean(recipient.signedAt?.trim());
}

function recipientHasSigned(
  recipient: Parameters<typeof signFlowRecipientHasSigned>[0],
): boolean {
  return signFlowRecipientHasSigned(recipient);
}

export function signFlowAnySponsorHasSigned(doc: SignFlowDocument): boolean {
  return (doc.recipients ?? [])
    .filter((recipient) => matchSignFlowPartyRole(recipient, "sponsor"))
    .some(recipientHasSigned);
}

export function isSignFlowOpenSponsorName(name: string | null | undefined): boolean {
  return String(name ?? "").trim().toLowerCase() === SIGNFLOW_OPEN_SPONSOR_NAME.toLowerCase();
}

function openSponsorDisplayName(name: string | null | undefined): string {
  const label = String(name ?? "").trim();
  if (!label || label.toLowerCase() === "sponsor") return SIGNFLOW_OPEN_SPONSOR_NAME;
  return label;
}

/** Generic Sponsor recipient: any deal sponsor may sign until one signature is recorded. */
export function isSignFlowOpenSponsorRecipient(recipient: {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}): boolean {
  const role = String(recipient.role ?? "").trim().toLowerCase();
  if (role === SIGNFLOW_OPEN_SPONSOR_ROLE) return true;
  if (String(recipient.name ?? "").includes(SIGNFLOW_OPEN_SPONSOR_MARK)) return true;
  const id = String(recipient.id ?? "").trim().toLowerCase();
  if (id === SIGNFLOW_OPEN_SPONSOR_RECIPIENT_ID) return true;
  if (isSignFlowOpenSponsorName(recipient.name)) return true;
  const email = String(recipient.email ?? "").trim().toLowerCase();
  // SignFlow labels this dropdown choice "Any sponsor".
  if (!email.includes("@") || email.endsWith("@embed.local")) return true;
  const name = String(recipient.name ?? "").trim().toLowerCase();
  return name === "any sponsor" || name === "sponsor";
}

/** Who may still counter-sign. An open slot stays available to every deal sponsor. */
export function signFlowPendingSponsorSignAudience(doc: SignFlowDocument): {
  openToAnySponsor: boolean;
  namedEmails: string[];
  allSponsorSlotsSigned: boolean;
} {
  const sponsors = (doc.recipients ?? []).filter((recipient) =>
    matchSignFlowPartyRole(recipient, "sponsor"),
  );
  if (sponsors.length === 0) {
    return {
      openToAnySponsor: false,
      namedEmails: [],
      allSponsorSlotsSigned: true,
    };
  }
  const unsigned = sponsors.filter((recipient) => !recipientHasSigned(recipient));
  const namedEmails = [
    ...new Set(
      unsigned
        .filter((recipient) => !isSignFlowOpenSponsorRecipient(recipient))
        .map((recipient) => String(recipient.email ?? "").trim().toLowerCase())
        .filter((email) => email.includes("@") && !email.endsWith("@embed.local")),
    ),
  ];
  return {
    openToAnySponsor: unsigned.some((recipient) =>
      isSignFlowOpenSponsorRecipient(recipient),
    ),
    namedEmails,
    allSponsorSlotsSigned: unsigned.length === 0,
  };
}

function matchSignFlowPartyRole(
  recipient: NonNullable<SignFlowDocument["recipients"]>[number],
  party: "investor" | "sponsor",
): boolean {
  const role = String(recipient.role ?? "").trim().toLowerCase();
  const id = String(recipient.id ?? "").trim().toLowerCase();
  if (party === "investor") {
    return (
      role.includes("investor") ||
      role.includes("buyer") ||
      id === "rec_investor" ||
      id === "rec_1" ||
      role === "recipient_a"
    );
  }
  return (
    role.includes("sponsor") ||
    role.includes("seller") ||
    id === "rec_sponsor" ||
    id === SIGNFLOW_OPEN_SPONSOR_RECIPIENT_ID ||
    id === "rec_2" ||
    role === "recipient_b"
  );
}

/** Blocks embedded signing when recipient order has not reached this party's turn. */
export function evaluateSignFlowRecipientSignAccess(
  doc: SignFlowDocument,
  recipientEmail: string,
  opts?: { investorHasCompletedSignature?: boolean },
): SignFlowRecipientSignAccess {
  const email = recipientEmail.trim().toLowerCase();
  const recipients = doc.recipients ?? [];
  if (!email || recipients.length === 0) {
    return { allowed: true };
  }

  const requester =
    recipients.find(
      (r) => String(r.email ?? "").trim().toLowerCase() === email,
    ) ?? null;
  if (!requester) {
    return { allowed: true };
  }

  const investors = recipients.filter((r) => matchSignFlowPartyRole(r, "investor"));
  const sponsor = recipients.find((r) => matchSignFlowPartyRole(r, "sponsor"));
  if (investors.length === 0 || !sponsor) {
    return { allowed: true };
  }

  const requesterIsInvestor = matchSignFlowPartyRole(requester, "investor");
  const requesterIsSponsor = matchSignFlowPartyRole(requester, "sponsor");
  const workflowType = String(doc.workflowType ?? "")
    .trim()
    .toLowerCase();
  // Parallel: investor or sponsor may sign without waiting for the other party.
  if (workflowType === "parallel") {
    return { allowed: true };
  }

  const sponsorOrder = Number(sponsor.order) || 2;
  const minInvestorOrder = Math.min(
    ...investors.map((r) => Number(r.order) || 1),
  );
  const sponsorSignsFirst = sponsorOrder < minInvestorOrder;
  const investorSignsFirst = minInvestorOrder < sponsorOrder;
  const anyInvestorSigned =
    opts?.investorHasCompletedSignature === true ||
    investors.some(recipientHasSigned);
  const sponsorSigned = recipientHasSigned(sponsor);

  if (requesterIsInvestor && sponsorSignsFirst && !sponsorSigned) {
    return {
      allowed: false,
      code: "waiting_for_prior_signer",
      waitingFor: "sponsor",
      message:
        "A sponsor must sign first. You will be able to sign after a sponsor completes their signature.",
    };
  }

  if (requesterIsSponsor && investorSignsFirst && !anyInvestorSigned) {
    return {
      allowed: false,
      code: "waiting_for_prior_signer",
      waitingFor: "investor",
      message:
        "At least one investor must sign first. Sponsor signing will open after an investor completes their signature.",
    };
  }

  return { allowed: true };
}

/**
 * Parallel documents share one signing turn. Older sends stored investor order 1
 * and sponsor order 2; equalize those so SignFlow lets either party sign.
 */
export async function ensureParallelPartiesMaySign(
  documentId: string,
  doc: SignFlowDocument,
): Promise<SignFlowDocument> {
  const workflowType = String(doc.workflowType ?? "")
    .trim()
    .toLowerCase();
  if (workflowType !== "parallel") return doc;
  const recipients = doc.recipients ?? [];
  if (recipients.length < 2) return doc;
  const orders = recipients.map((r) => Number(r.order) || 1);
  if (orders.every((order) => order === orders[0])) return doc;
  return patchSignFlowDocument(documentId, {
    workflowType: "parallel",
    recipients: recipients.map((recipient) => ({ ...recipient, order: 1 })),
  });
}

export async function patchSignFlowDocument(
  documentId: string,
  body: Record<string, unknown>,
): Promise<SignFlowDocument> {
  // Do not resend a previously read field list. A recipient-only patch used to
  // attach that snapshot and put deleted fields back after the editor saved.
  const doc = await signflowRequest<SignFlowDocument>(
    `/documents/${encodeURIComponent(documentId.trim())}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!doc?.id) {
    throw new Error("SignFlow returned an incomplete document patch response");
  }
  return doc;
}

/** Original template PDF stored on the SignFlow document (not a signed copy). */
export async function downloadSignFlowSourcePdf(
  doc: SignFlowDocument,
): Promise<Buffer | null> {
  const { baseUrl, apiKey } = requireSignFlowConfig();
  const candidates: string[] = [];
  const fileUrl = doc.fileUrl?.trim();
  if (fileUrl) {
    candidates.push(
      /^https?:\/\//i.test(fileUrl) ? fileUrl : buildUrl(baseUrl, fileUrl),
    );
  }
  const documentId = doc.id?.trim();
  if (documentId) {
    const encoded = encodeURIComponent(documentId);
    candidates.push(buildUrl(baseUrl, `/documents/${encoded}/file`));
    candidates.push(buildUrl(baseUrl, `/documents/${encoded}/download`));
  }

  for (const url of candidates) {
    try {
      const headers: Record<string, string> = {};
      if (url.startsWith(baseUrl)) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 4).toString() === "%PDF") return buf;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

export async function downloadSignFlowSignedPdfBuffer(
  documentId: string,
): Promise<Buffer> {
  const { baseUrl, apiKey } = requireSignFlowConfig();
  const res = await fetch(
    buildUrl(baseUrl, `/documents/${encodeURIComponent(documentId.trim())}/download`),
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) {
    throw new Error(await parseSignFlowError(res));
  }
  return Buffer.from(await res.arrayBuffer());
}

export function isSignFlowNotAllSignedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("NOT_ALL_SIGNED");
}

export function isSignFlowInvestorNotSignedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("INVESTOR_NOT_SIGNED");
}

function signFlowRecipientSigningStatusSigned(recipient: {
  signed?: boolean;
  signingStatus?: string;
}): boolean {
  if (recipient.signed === true) return true;
  const status = String(recipient.signingStatus ?? "").trim().toLowerCase();
  return status === "signed" || status === "completed";
}

function isSignFlowInvestorRecipient(recipient: {
  id?: string;
  role?: string;
}): boolean {
  const role = String(recipient.role ?? "").trim().toLowerCase();
  const id = String(recipient.id ?? "").trim().toLowerCase();
  return (
    role.includes("investor") ||
    role.includes("buyer") ||
    id === "rec_investor" ||
    id === "rec_1" ||
    role === "recipient_a"
  );
}

export async function downloadSignFlowRecipientSignedPdfBuffer(
  documentId: string,
  recipientId: string,
): Promise<Buffer> {
  const { baseUrl, apiKey } = requireSignFlowConfig();
  const docId = encodeURIComponent(documentId.trim());
  const recId = encodeURIComponent(recipientId.trim());
  const res = await fetch(
    buildUrl(baseUrl, `/documents/${docId}/recipients/${recId}/download`),
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) {
    throw new Error(await parseSignFlowError(res));
  }
  return Buffer.from(await res.arrayBuffer());
}

async function resolveSignedInvestorRecipientId(
  documentId: string,
): Promise<string> {
  const doc = await getSignFlowDocument(documentId);
  let signedInvestorId =
    (doc.recipients ?? []).find(
      (recipient) =>
        isSignFlowInvestorRecipient(recipient) &&
        signFlowRecipientSigningStatusSigned(recipient),
    )?.id?.trim() ?? "";

  if (!signedInvestorId) {
    const summary = await getSignFlowDocumentSummary(documentId);
    const signedSigner = summary.signers.find((signer) => {
      const code = String(signer.statusCode ?? "").trim().toLowerCase();
      const signed =
        code === "signed" ||
        code === "completed" ||
        Boolean(signer.signedAt?.trim());
      if (!signed) return false;
      const email = signer.signerEmail?.trim().toLowerCase() ?? "";
      const recipient = (doc.recipients ?? []).find(
        (item) => item.email?.trim().toLowerCase() === email,
      );
      return recipient ? isSignFlowInvestorRecipient(recipient) : true;
    });
    signedInvestorId = signedSigner?.recipientId?.trim() ?? "";
  }

  if (!signedInvestorId) {
    throw new Error(
      "INVESTOR_NOT_SIGNED: Investor has not signed this document yet",
    );
  }

  return signedInvestorId;
}

/** Investor-only signed PDF (their certificate of completion, no sponsor audit). */
export async function downloadSignFlowInvestorSignedPdfBuffer(
  documentId: string,
): Promise<Buffer> {
  const signedInvestorId = await resolveSignedInvestorRecipientId(documentId);
  return downloadSignFlowRecipientSignedPdfBuffer(
    documentId,
    signedInvestorId,
  );
}

/**
 * Full combined PDF when all signers are done; otherwise the investor's signed
 * copy when sequential workflow leaves sponsor pending.
 */
export async function downloadSignFlowBestAvailableSignedPdfBuffer(
  documentId: string,
): Promise<Buffer> {
  try {
    return await downloadSignFlowSignedPdfBuffer(documentId);
  } catch (err) {
    if (!isSignFlowNotAllSignedError(err)) throw err;
  }

  return downloadSignFlowInvestorSignedPdfBuffer(documentId);
}

export type SignFlowDocumentSummary = {
  documentId: string;
  status: string;
  isComplete: boolean;
  isDeclined: boolean;
  lastViewedAt: string | null;
  /** Latest signature from any signer (sponsor or investor). */
  lastSignedAt: string | null;
  /** Latest signature from an investor-role signer only. */
  investorLastSignedAt: string | null;
  signers: Array<{
    recipientId: string | null;
    signerName: string | null;
    signerEmail: string | null;
    statusCode: string | null;
    lastViewedAt: string | null;
    signedAt: string | null;
  }>;
};

/** True when an investor-role recipient has signed on a live SignFlow document. */
export function signFlowDocumentInvestorHasSigned(
  doc: SignFlowDocument,
): boolean {
  return (doc.recipients ?? [])
    .filter((recipient) => isSignFlowInvestorRecipient(recipient))
    .some(signFlowRecipientSigningStatusSigned);
}

/** True when an investor signer has completed on a SignFlow document summary. */
export function signFlowSummaryInvestorHasSigned(
  summary: Pick<SignFlowDocumentSummary, "signers">,
  doc?: Pick<SignFlowDocument, "recipients">,
): boolean {
  const recipients = doc?.recipients ?? [];
  return summary.signers.some((signer) => {
    const signed = Boolean(signer.signedAt?.trim()) ||
      ["signed", "completed"].includes(
        String(signer.statusCode ?? "").trim().toLowerCase(),
      );
    if (!signed) return false;
    const recipientId = signer.recipientId?.trim() ?? "";
    const recipient = recipients.find((r) => r.id?.trim() === recipientId);
    if (recipient) return isSignFlowInvestorRecipient(recipient);
    const email = signer.signerEmail?.trim().toLowerCase() ?? "";
    const byEmail = recipients.find(
      (r) => r.email?.trim().toLowerCase() === email,
    );
    if (byEmail) return isSignFlowInvestorRecipient(byEmail);
    return true;
  });
}

export async function getSignFlowDocumentSummary(
  documentId: string,
): Promise<SignFlowDocumentSummary> {
  const doc = await getSignFlowDocument(documentId);
  const status = String(doc.status ?? "").trim().toLowerCase();
  const signers = (doc.recipients ?? []).map((r) => ({
    recipientId: r.id?.trim() ?? null,
    signerName: r.name?.trim() ?? null,
    signerEmail: r.email?.trim() ?? null,
    statusCode: r.signingStatus?.trim() ?? null,
    lastViewedAt: null,
    signedAt: signFlowRecipientSigningStatusSigned(r)
      ? (r.signedAt?.trim() ?? doc.updatedAt ?? null)
      : null,
  }));
  const investorSignedAt =
    signers.find((s) => {
      if (!s.signedAt?.trim()) return false;
      const recipient = (doc.recipients ?? []).find(
        (r) => r.id?.trim() === (s.recipientId?.trim() ?? ""),
      );
      return recipient ? isSignFlowInvestorRecipient(recipient) : false;
    })?.signedAt ?? null;
  const lastSignedAt =
    investorSignedAt ??
    signers.find((s) => s.signedAt)?.signedAt ??
    null;
  return {
    documentId: doc.id,
    status,
    isComplete: status === "completed",
    isDeclined: status === "declined",
    lastViewedAt: null,
    lastSignedAt,
    investorLastSignedAt: investorSignedAt,
    signers,
  };
}
