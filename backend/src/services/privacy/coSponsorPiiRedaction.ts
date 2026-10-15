import {
  isCompanyAdminRole,
  isPlatformAdminRole,
} from "../../constants/roles.js";

/**
 * Response-only mask. Stored contact and investor email/phone are never
 * replaced with this value.
 */
export const PII_REDACTED = "redacted";

export const PII_EMAIL_REDACTED = PII_REDACTED;

export const PII_PHONE_REDACTED = PII_REDACTED;

/**
 * Contacts page in the selected company: a co-sponsor's contacts stay on that
 * co-sponsor's own list. Other users in the company do not receive the rows.
 * Role is the viewer's role in the selected company, not their primary company.
 */
export function viewerSeesOnlyOwnContactsInSelectedCompany(params: {
  roleInSelectedCompany: string | null | undefined;
  isLeadOrAdminSponsorInSelectedCompany: boolean;
  isCoSponsorInSelectedCompany: boolean;
}): boolean {
  if (isPlatformAdminRole(params.roleInSelectedCompany)) return false;
  if (isCompanyAdminRole(params.roleInSelectedCompany)) return false;
  if (params.isLeadOrAdminSponsorInSelectedCompany) return false;
  return params.isCoSponsorInSelectedCompany === true;
}

/**
 * A co-sponsor's contacts stay hidden from the other company. They stay
 * visible to that co-sponsor and to the company admin and lead/admin sponsors
 * of the co-sponsor's own company.
 */
export function coSponsorOwnedContactVisibleToViewer(params: {
  createdByUserId: string | null | undefined;
  viewerIdsLower: ReadonlySet<string>;
  creatorIsPrivateCoSponsorInSelectedCompany: boolean;
  viewerIsCompanyAdminOrLeadOfCreatorCompany?: boolean;
}): boolean {
  if (!params.creatorIsPrivateCoSponsorInSelectedCompany) return true;
  if (params.viewerIsCompanyAdminOrLeadOfCreatorCompany) return true;
  const createdBy = String(params.createdByUserId ?? "").trim().toLowerCase();
  if (createdBy && params.viewerIdsLower.has(createdBy)) return true;
  return false;
}

export function redactContactEmailAndPhone<
  T extends { email?: string | null; phone?: string | null },
>(row: T): T {
  return {
    ...row,
    email: PII_EMAIL_REDACTED,
    phone: PII_PHONE_REDACTED,
  };
}

export function isLeadOrAdminDealViewerRole(
  role: string | null | undefined,
): boolean {
  return role === "lead_sponsor" || role === "admin_sponsor";
}

/**
 * Deal Investors tab: lead and admin sponsors keep the row, including other
 * permitted fields, and lose only the investor email and phone when a
 * co-sponsor added that investor. The adding co-sponsor still sees both.
 */
export function redactCoSponsorInvestorEmailAndPhone<
  T extends {
    userEmail?: string;
    userPhone?: string;
    addedByUserId?: string;
    addedByIsCoSponsorOnDeal?: boolean;
  },
>(row: T, viewerIdsLower: ReadonlySet<string>): T {
  if (row.addedByIsCoSponsorOnDeal !== true) return row;
  const addedBy = String(row.addedByUserId ?? "").trim().toLowerCase();
  if (addedBy && viewerIdsLower.has(addedBy)) return row;
  return {
    ...row,
    userEmail: PII_EMAIL_REDACTED,
    userPhone: PII_PHONE_REDACTED,
  };
}
