export type EsignSignflowWorkflowType = "parallel" | "sequential";
export type EsignSignflowSigningOrder = "investor_first" | "sponsor_first";

export const DEFAULT_ESIGN_SIGNFLOW_WORKFLOW_TYPE: EsignSignflowWorkflowType =
  "sequential";
export const DEFAULT_ESIGN_SIGNFLOW_SIGNING_ORDER: EsignSignflowSigningOrder =
  "investor_first";

export function normalizeEsignSignflowWorkflowType(
  raw: unknown,
): EsignSignflowWorkflowType | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "parallel" || v === "sequential") return v;
  return null;
}

export function normalizeEsignSignflowSigningOrder(
  raw: unknown,
): EsignSignflowSigningOrder | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (v === "investor_first" || v === "investor") return "investor_first";
  if (v === "sponsor_first" || v === "sponsor") return "sponsor_first";
  return null;
}

export function resolveEsignSignflowWorkflowType(file: {
  signflowWorkflowType?: string | null;
}): EsignSignflowWorkflowType {
  return (
    normalizeEsignSignflowWorkflowType(file.signflowWorkflowType) ??
    DEFAULT_ESIGN_SIGNFLOW_WORKFLOW_TYPE
  );
}

export function resolveEsignSignflowSigningOrder(file: {
  signflowSigningOrder?: string | null;
}): EsignSignflowSigningOrder {
  return (
    normalizeEsignSignflowSigningOrder(file.signflowSigningOrder) ??
    DEFAULT_ESIGN_SIGNFLOW_SIGNING_ORDER
  );
}

export function resolveSignFlowRecipientOrders(
  workflowType: EsignSignflowWorkflowType,
  signingOrder: EsignSignflowSigningOrder,
): { investorOrder: number; sponsorOrder: number } {
  // Parallel: investor and sponsor share one turn, so either party may sign.
  if (workflowType === "parallel") {
    return { investorOrder: 1, sponsorOrder: 1 };
  }
  if (signingOrder === "sponsor_first") {
    return { investorOrder: 2, sponsorOrder: 1 };
  }
  return { investorOrder: 1, sponsorOrder: 2 };
}
