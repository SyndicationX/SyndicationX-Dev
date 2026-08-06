import {
  SESSION_BEARER_KEY,
  SESSION_USER_DETAILS_KEY,
} from "./sessionKeys";
import { decodeJwtPayload } from "../../modules/auth/utils/decode-jwt-payload";

export const PLATFORM_ADMIN = "platform_admin";
export const COMPANY_ADMIN = "company_admin";
export const PLATFORM_USER = "platform_user";
export const COMPANY_USER = "company_user";
export const DEAL_PARTICIPANT = "deal_participant";
/** Self-serve signup without a company — investing portal only. */
export const INVESTOR = "investor";

/** Legacy role from older installs */
const LEGACY_USER = "user";

export function normalizeRole(role: string | null | undefined): string {
  const r = String(role ?? "").trim();
  if (r === "") return PLATFORM_USER;
  if (r === LEGACY_USER) return PLATFORM_USER;
  return r;
}

/**
 * Role for UI and routing. Sign-in stores the same snapshot as the login API (`userDetails`);
 * JWT is the fallback (e.g. partial session). Backend member APIs use DB `users.role` — keep
 * `userDetails` in sync by signing out/in after role changes.
 */
export function getStoredUserRole(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_USER_DETAILS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr[0] && typeof arr[0] === "object") {
        const role = (arr[0] as Record<string, unknown>).role;
        if (typeof role === "string" && role.trim() !== "") {
          return normalizeRole(role);
        }
      }
    }
  } catch {
    /* ignore */
  }
  const token = sessionStorage.getItem(SESSION_BEARER_KEY);
  if (token) {
    const p = decodeJwtPayload<{ userRole?: string }>(token);
    if (p?.userRole != null && String(p.userRole).trim() !== "") {
      return normalizeRole(String(p.userRole));
    }
  }
  return null;
}

export function isPlatformAdmin(): boolean {
  return getStoredUserRole() === PLATFORM_ADMIN;
}

/** Platform + company admins can open the Members area. */
export function canAccessMembersPage(): boolean {
  const r = getStoredUserRole();
  return r === PLATFORM_ADMIN || r === COMPANY_ADMIN;
}

/** Platform admins, company admins, and members can open the Company page (create is admin-only). */
export function canAccessCompanyPage(): boolean {
  const r = getStoredUserRole();
  if (r === DEAL_PARTICIPANT) return false;
  return (
    r === PLATFORM_ADMIN ||
    r === COMPANY_ADMIN ||
    r === PLATFORM_USER ||
    r === COMPANY_USER
  );
}

/** Syndication workspace settings (`/settings` → org CompanyPage tabs). */
export function canAccessSyndicationWorkspaceSettings(): boolean {
  return canAccessCompanyPage();
}

/**
 * Sidebar “Settings” target in Syndicating mode.
 * Deal participants (e.g. Lead / Admin / Co-sponsor on a deal) use My account instead.
 */
export function resolveSyndicationSettingsNavPath(): "/settings" | "/account" {
  return canAccessSyndicationWorkspaceSettings() ? "/settings" : "/account";
}

export function isCompanyAdmin(): boolean {
  return getStoredUserRole() === COMPANY_ADMIN;
}

/** Org-scoped roles may edit workspace tabs when their `organizationId` matches the target company. */
export function canEditCompanyWorkspace(): boolean {
  const r = getStoredUserRole();
  if (r === DEAL_PARTICIPANT) return false;
  return (
    r === PLATFORM_ADMIN ||
    r === COMPANY_ADMIN ||
    r === PLATFORM_USER ||
    r === COMPANY_USER
  );
}

export function getStoredSessionUserRecord(): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(SESSION_USER_DETAILS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && arr[0] && typeof arr[0] === "object") {
      return arr[0] as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** `deal_member` roster label is LP (canonical + legacy spellings). */
export function dealMemberRoleLabelIsLpInvestor(label: string): boolean {
  const t = String(label ?? "").trim().toLowerCase();
  if (!t) return false;
  return (
    t === "lp_investors" ||
    t === "lp investors" ||
    t === "lp investor"
  );
}

/** Portal `users.role` is `deal_participant` (from session or JWT-backed snapshot). */
export function isDealParticipantUser(): boolean {
  const u = getStoredSessionUserRecord();
  if (!u) return false;
  if (u.is_deal_participant === true) return true;
  return String(u.role ?? "").trim().toLowerCase() === DEAL_PARTICIPANT;
}

/**
 * Investing-only shell when `deal_lp_investor` matched the user’s email with an LP role
 * (`lp_investor_nav` from {@link mergeLpInvestorFlagsIntoUserPayload} — not `deal_member`).
 */
export function isLpInvestorSessionUser(): boolean {
  const u = getStoredSessionUserRecord();
  if (!u) return false;
  return u.lp_investor_nav === true;
}

/** Deal ids from `deal_lp_investor` (API `lp_investor_deal_ids`); empty if not LP scope. */
export function getLpInvestorDealIdsFromSession(): string[] {
  const u = getStoredSessionUserRecord();
  if (!u) return [];
  const raw = u.lp_investor_deal_ids ?? u.lp_investor_dealIds;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}
