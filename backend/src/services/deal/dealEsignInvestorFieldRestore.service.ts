import type { StoredInvestorEsignFieldValue } from "../../constants/deal-investor-esign-status.js";
import type { InvestorEsignRowTarget } from "./dealMemberEsignStatus.service.js";
import { isOnboardingFieldsServiceConfigured } from "../../config/onboardingFields.config.js";
import {
  getSignFlowDocument,
  normalizeSignFlowFieldsForApi,
  patchSignFlowDocument,
  resolveSignFlowInvestorRecipientId,
  type SignFlowField,
} from "../esign/signflow.service.js";
import { getDealInvestorQuestionnaireState } from "./dealInvestorQuestionnaire.service.js";
import { buildEsignPrefillContext } from "./dealMemberSendEsignDropbox.service.js";
import { resolveQuestionnaireAnswersForEsign } from "./investorProfileQuestionnairePrefill.service.js";
import {
  applyQuestionnairePrefillToSignFlowFields,
  maskSsnInQuestionnaireAnswers,
  maskSsnValuesOnSignFlowFields,
} from "./investorQuestionnaireEsignPrefill.service.js";
import { fetchPrefilledOnboardingFields } from "../onboarding/onboardingFieldsPython.service.js";

type LiveField = SignFlowField & { id?: string };

function isInvestorField(
  field: { recipientId?: string },
  investorRecipientId: string,
): boolean {
  const recipientId = String(field.recipientId ?? "").trim();
  if (investorRecipientId && recipientId === investorRecipientId) return true;
  const role = recipientId.toLowerCase();
  return (
    role.includes("investor") ||
    role.includes("buyer") ||
    role === "rec_investor" ||
    role === "rec_1"
  );
}

function fieldValue(field: { value?: string | null }): string {
  return String(field.value ?? "").trim();
}

function samePlacement(
  field: { label?: string; page?: number; type?: string; x?: number; y?: number },
  saved: StoredInvestorEsignFieldValue,
): boolean {
  const label = String(field.label ?? "").trim().toLowerCase();
  const savedLabel = saved.label.trim().toLowerCase();
  if (!label || label !== savedLabel) return false;
  if (Math.floor(Number(field.page) || 1) !== Math.floor(saved.page || 1)) {
    return false;
  }
  const type = String(field.type ?? "").trim().toLowerCase();
  const savedType = String(saved.type ?? "").trim().toLowerCase();
  if (type && savedType && type !== savedType) return false;
  if (saved.x == null || saved.y == null) return true;
  return (
    Math.abs((Number(field.x) || 0) - saved.x) < 1.5 &&
    Math.abs((Number(field.y) || 0) - saved.y) < 1.5
  );
}

function savedValueFor(
  field: LiveField,
  saved: StoredInvestorEsignFieldValue[],
): string {
  const id = String(field.id ?? "").trim();
  if (id) {
    const byId = saved.find((item) => item.id === id && item.value.trim());
    if (byId) return byId.value.trim();
  }
  const byPlace = saved.find(
    (item) => item.value.trim() && samePlacement(field, item),
  );
  return byPlace?.value.trim() ?? "";
}

export function snapshotInvestorFieldValues(
  fields: LiveField[],
  investorRecipientId = "",
): StoredInvestorEsignFieldValue[] {
  const out: StoredInvestorEsignFieldValue[] = [];
  for (const field of fields) {
    if (!isInvestorField(field, investorRecipientId)) continue;
    const value = fieldValue(field);
    if (!value) continue;
    const label = String(field.label ?? "").trim() || "Field";
    const id = String(field.id ?? "").trim();
    const type = String(field.type ?? "").trim();
    out.push({
      label,
      page: Math.floor(Number(field.page) || 1),
      value,
      x: Number(field.x) || 0,
      y: Number(field.y) || 0,
      ...(id ? { id } : {}),
      ...(type ? { type } : {}),
    });
  }
  return out;
}

function mergeSaved(
  current: StoredInvestorEsignFieldValue[],
  incoming: StoredInvestorEsignFieldValue[],
): StoredInvestorEsignFieldValue[] {
  const merged = [...current];
  for (const item of incoming) {
    const exists = merged.some(
      (saved) =>
        (item.id && saved.id === item.id) || samePlacement(item, saved),
    );
    if (!exists) merged.push(item);
  }
  return merged;
}

/** Read the answers currently stored on the SignFlow document. */
export async function readLiveInvestorFieldValues(
  signatureRequestId: string,
  alreadySaved: StoredInvestorEsignFieldValue[] = [],
): Promise<StoredInvestorEsignFieldValue[]> {
  const doc = await getSignFlowDocument(signatureRequestId);
  const investorRecipientId = resolveSignFlowInvestorRecipientId(doc);
  const live = snapshotInvestorFieldValues(
    (doc.fields ?? []) as LiveField[],
    investorRecipientId,
  );
  return mergeSaved(alreadySaved, live);
}

async function prefilledInvestorFields(params: {
  dealId: string;
  target: InvestorEsignRowTarget;
  investorEmail: string;
  fields: LiveField[];
}): Promise<LiveField[]> {
  const config = await getDealInvestorQuestionnaireState(params.dealId);
  const answers = await resolveQuestionnaireAnswersForEsign({
    dealId: params.dealId,
    esignTarget: params.target,
  });
  const prefillContext = await buildEsignPrefillContext({
    dealId: params.dealId,
    esignTarget: params.target,
    memberEmail: params.investorEmail,
  });
  let next = applyQuestionnairePrefillToSignFlowFields({
    fields: params.fields,
    config,
    answers: answers ?? {},
    prefillContext,
    maskSsn: true,
  }) as LiveField[];
  if (isOnboardingFieldsServiceConfigured()) {
    next = (await fetchPrefilledOnboardingFields({
      fields: next,
      answers: maskSsnInQuestionnaireAnswers(answers ?? {}, config),
      context: {
        member_display_name: prefillContext.memberDisplayName,
        member_email: prefillContext.memberEmail,
        investment_amount: prefillContext.investmentAmount,
        subscription_amount: prefillContext.subscriptionAmount,
        unit_amount: prefillContext.unitAmount,
        unit_count: prefillContext.unitCount,
        address_line: prefillContext.addressLine,
        mailing_address_line: prefillContext.mailingAddressLine,
        street_line: prefillContext.streetLine,
        city: prefillContext.city,
        state: prefillContext.state,
        zip: prefillContext.zip,
        city_state_zip: prefillContext.cityStateZip,
      },
    })) as LiveField[];
    next = maskSsnValuesOnSignFlowFields(next) as LiveField[];
  }
  return next;
}

/**
 * Put the investor's earlier answers back on the SignFlow document
 * before the edit signing session opens.
 */
export async function restoreInvestorEsignFieldsForEdit(params: {
  dealId: string;
  target: InvestorEsignRowTarget;
  signatureRequestId: string;
  investorEmail: string;
  savedValues: StoredInvestorEsignFieldValue[];
}): Promise<StoredInvestorEsignFieldValue[]> {
  const doc = await getSignFlowDocument(params.signatureRequestId);
  const investorRecipientId = resolveSignFlowInvestorRecipientId(doc);
  const live = (doc.fields ?? []) as LiveField[];
  if (live.length === 0) return params.savedValues;

  let prefilled: LiveField[] = live;
  try {
    prefilled = await prefilledInvestorFields({
      dealId: params.dealId,
      target: params.target,
      investorEmail: params.investorEmail,
      fields: live,
    });
  } catch (err) {
    console.warn("restoreInvestorEsignFieldsForEdit prefill:", err);
  }

  let changed = false;
  const next = live.map((field) => {
    if (!isInvestorField(field, investorRecipientId)) return field;
    const current = fieldValue(field);
    const saved = savedValueFor(field, params.savedValues);
    const fromPrefill = prefillValueFor(field, prefilled);
    const value = current || saved || fromPrefill;
    if (!value || value === current) return field;
    changed = true;
    return { ...field, value };
  });

  if (changed) {
    await patchSignFlowDocument(params.signatureRequestId, {
      fields: normalizeSignFlowFieldsForApi(next.map(toPatchField)),
    });
  }

  return snapshotInvestorFieldValues(
    changed ? next : live,
    investorRecipientId,
  );
}

function prefillValueFor(field: LiveField, prefilled: LiveField[]): string {
  const id = String(field.id ?? "").trim();
  if (id) {
    const byId = prefilled.find((item) => String(item.id ?? "").trim() === id);
    const fromId = fieldValue(byId ?? {});
    if (fromId) return fromId;
  }
  const match = prefilled.find((item) =>
    samePlacement(field, {
      label: String(item.label ?? ""),
      page: Math.floor(Number(item.page) || 1),
      type: item.type,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      value: "x",
    }),
  );
  return fieldValue(match ?? {});
}

function toPatchField(field: LiveField): SignFlowField & { id?: string } {
  const value = fieldValue(field);
  return {
    ...(field.id ? { id: field.id } : {}),
    type: String(field.type ?? "text"),
    label: String(field.label ?? "Field"),
    x: Number(field.x) || 0,
    y: Number(field.y) || 0,
    width: Math.max(1, Number(field.width) || 1),
    height: Math.max(1, Number(field.height) || 1),
    page: Math.max(1, Math.floor(Number(field.page) || 1)),
    recipientId: String(field.recipientId ?? ""),
    required: field.required !== false,
    ...(value ? { value } : {}),
    ...(field.radioGroupId ? { radioGroupId: field.radioGroupId } : {}),
    ...(field.profileType ? { profileType: field.profileType } : {}),
    ...(field.profileTypes?.length ? { profileTypes: field.profileTypes } : {}),
  };
}
