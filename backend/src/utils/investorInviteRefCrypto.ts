import {
  createCipheriv,
  createDecipheriv,
  createHash,
  scryptSync,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KDF_SALT = "investor-invite-ref-v1";
/** Mixed into SHA-256 so IV derivation is distinct from other hashes. */
const IV_DOMAIN = "investor-invite-ref-iv-v1";
const DEAL_IV_DOMAIN = "investor-invite-ref-deal-iv-v1";
/** v2 tokens bind a company id; a distinct IV domain avoids reusing v1 IVs. */
const V2_IV_DOMAIN = "investor-invite-ref-iv-v2";

export type InvestorInviteRefPayload = {
  sponsorUserId: string;
  dealId: string | null;
  /** Company the sharer was working in when they created the link. */
  companyId: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretKey(): Buffer {
  const s =
    process.env.INVESTOR_INVITE_SECRET?.trim() ||
    process.env.OFFERING_PREVIEW_SECRET?.trim();
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "INVESTOR_INVITE_SECRET (or OFFERING_PREVIEW_SECRET) is required in production.",
      );
    }
    return scryptSync("dev-insecure-investor-invite", KDF_SALT, 32);
  }
  return scryptSync(s, KDF_SALT, 32);
}

/**
 * Stable IV per sponsor id so the same secret + user always yields the same ref
 * (a sponsor's invite link does not change between visits).
 */
function deterministicIvForSponsor(normalizedUserId: string): Buffer {
  return createHash("sha256")
    .update(normalizedUserId, "utf8")
    .update("\0", "utf8")
    .update(IV_DOMAIN, "utf8")
    .digest()
    .subarray(0, IV_LEN);
}

function deterministicIvForSponsorAndDeal(
  normalizedUserId: string,
  normalizedDealId: string,
): Buffer {
  return createHash("sha256")
    .update(normalizedUserId, "utf8")
    .update("\0", "utf8")
    .update(normalizedDealId, "utf8")
    .update("\0", "utf8")
    .update(DEAL_IV_DOMAIN, "utf8")
    .digest()
    .subarray(0, IV_LEN);
}

function deterministicIvV2(parts: string[]): Buffer {
  const hash = createHash("sha256").update(V2_IV_DOMAIN, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8").update(part, "utf8");
  }
  return hash.digest().subarray(0, IV_LEN);
}

function sealInviteRef(payload: string, iv: Buffer): string {
  const key = secretKey();
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

/**
 * Encrypted sponsor attribution for the investor signup URL (`ref=` query param).
 * When a company id is known, the token is v2 (`2:sponsor:company[:deal]`) so signup
 * can store that company. Links without a company stay on the original format.
 */
export function encryptInvestorInviteRef(
  sponsorUserId: string,
  dealId?: string | null,
  companyId?: string | null,
): string {
  const id = String(sponsorUserId ?? "").trim();
  if (!UUID_RE.test(id)) {
    throw new Error("Invalid sponsor id for investor invite ref.");
  }
  const normalized = id.toLowerCase();
  const deal = String(dealId ?? "").trim().toLowerCase();
  const company = String(companyId ?? "").trim().toLowerCase();
  const hasDeal = Boolean(deal) && UUID_RE.test(deal);
  const hasCompany = Boolean(company) && UUID_RE.test(company);
  if (hasCompany) {
    const payload = hasDeal
      ? `2:${normalized}:${company}:${deal}`
      : `2:${normalized}:${company}`;
    const iv = deterministicIvV2(
      hasDeal ? [normalized, company, deal] : [normalized, company],
    );
    return sealInviteRef(payload, iv);
  }
  const payload = hasDeal ? `${normalized}:${deal}` : normalized;
  const iv = hasDeal
    ? deterministicIvForSponsorAndDeal(normalized, deal)
    : deterministicIvForSponsor(normalized);
  return sealInviteRef(payload, iv);
}

export function decryptInvestorInviteRef(
  refToken: string,
): InvestorInviteRefPayload | null {
  const raw = String(refToken ?? "").trim();
  if (!raw || raw.split(".").length !== 3) return null;
  const [ivB64, tagB64, dataB64] = raw.split(".");
  try {
    const key = secretKey();
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    if (iv.length !== IV_LEN || tag.length !== 16) return null;
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    const payload = dec.toString("utf8").trim();
    if (payload.startsWith("2:")) {
      const parts = payload.split(":");
      if (parts.length !== 3 && parts.length !== 4) return null;
      const sponsorUserId = parts[1]?.trim() ?? "";
      const companyId = parts[2]?.trim() ?? "";
      const dealId = parts.length === 4 ? (parts[3]?.trim() ?? "") : "";
      if (!UUID_RE.test(sponsorUserId) || !UUID_RE.test(companyId)) return null;
      if (dealId && !UUID_RE.test(dealId)) return null;
      return {
        sponsorUserId,
        companyId,
        dealId: dealId || null,
      };
    }
    const sep = payload.indexOf(":");
    if (sep < 0) {
      return UUID_RE.test(payload)
        ? { sponsorUserId: payload, dealId: null, companyId: null }
        : null;
    }
    const sponsorUserId = payload.slice(0, sep).trim();
    const dealId = payload.slice(sep + 1).trim();
    if (!UUID_RE.test(sponsorUserId) || !UUID_RE.test(dealId)) return null;
    return { sponsorUserId, dealId, companyId: null };
  } catch {
    return null;
  }
}
