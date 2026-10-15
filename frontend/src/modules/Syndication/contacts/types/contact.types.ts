export type ContactStatus = "active" | "suspended"

export type ContactSource = "local" | "ghl"
export type ContactImportSource =
  | "manual"
  | "csv"
  | "excel"
  | "invite_link"
  | "portal_signup"
  | "ghl"

/**
 * Per-contact offering visibility on the Investing portal only.
 * Applied per organization. That sponsor's 506(c) offerings stay visible to every contact there. The setting only changes 506(b) and other non-506(c) deals. `null` / unset still shows a 506(b) deal only when this investor is already on it.
 */
export type ContactOfferingVisibility =
  | "ALL_OFFERINGS"
  | "HIDE_OFFERINGS"
  | "506B_ONLY"
  | "506C_ONLY"

export const CONTACT_OFFERING_VISIBILITY_OPTIONS: ReadonlyArray<{
  value: ContactOfferingVisibility
  label: string
}> = [
  { value: "ALL_OFFERINGS", label: "Show Offerings" },
  { value: "HIDE_OFFERINGS", label: "Hide Offerings" },
  { value: "506B_ONLY", label: "506(b) offerings only" },
  { value: "506C_ONLY", label: "506(c) offerings only" },
]

/** 506(b) pre-existing relationship on a CRM contact. */
export type ContactRelationship506b = "YES" | "NO"

export const CONTACT_RELATIONSHIP_506B_OPTIONS: ReadonlyArray<{
  value: ContactRelationship506b
  label: string
}> = [
  { value: "YES", label: "506(b) Yes" },
  { value: "NO", label: "506(b) No" },
]

/** One deal shown on a contact’s Deals tab. */
export interface ContactDealRow {
  dealId: string
  dealName: string
  contactRole: string
  dealOrganization: string
  /** ISO time the contact last opened this deal. Null when they never have. */
  lastWentAt: string | null
}

export interface ContactRow {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  note: string
  tags: string[]
  lists: string[]
  owners: string[]
  /** `active` (default) or `suspended` */
  status?: ContactStatus
  /**
   * Offering visibility for this contact.
   * `null` when unset (optional field).
   * Stored in DB as `contact.show_offerings_visibility`.
   */
  showOfferingsVisibility?: ContactOfferingVisibility | null
  /** Accreditation status; `null` when unset */
  accreditationStatus?: string | null
  /** Relationship start date (YYYY-MM-DD); `null` when unset */
  knownSince?: string | null
  /**
   * 506(b) pre-existing relationship.
   * Defaults to `NO` when unset. Stored as `contact.relationship_506b`.
   */
  relationship506b?: ContactRelationship506b | null
  /** Reason from the most recent edit (required when saving edits) */
  lastEditReason?: string
  /** Resolved display name for the user who created the row (from API) */
  createdByDisplayName?: string
  /**
   * Sponsor whose invite link was used, or the user who added the contact
   * when that person is not the contact themselves.
   */
  invitedByDisplayName?: string
  /** Portal user id of the person whose invite link was used. */
  invitedByUserId?: string
  /** Portal user id that created the CRM row. */
  createdByUserId?: string
  /** Company (`companies.id`) this contact belongs to. */
  organizationId?: string
  /** Company (`companies.name`) this contact belongs to. */
  organizationName?: string
  /** Company of the user who added this contact. */
  addedByCompanyName?: string
  /** ISO timestamp when the contact was created (from API) */
  createdAt?: string
  /**
   * Self-registered investor opted in to appear in Platform Contacts
   * for company users. Platform admins see the row either way.
   */
  visibleToUsers?: boolean
  /**
   * Self-registered investor CRM row. Hidden (`visibleToUsers` false) rows
   * cannot be added to deals.
   */
  platformAdminOnly?: boolean
  /** Linked to a portal `users` row for this email. */
  isPortalUser?: boolean
  /** True after a portal signup invitation was successfully emailed. */
  invitationEmailSent?: boolean
  /** Server-computed: invite can be sent from row actions. */
  canSendInvitationEmail?: boolean
  /**
   * Distinct deals linked to this contact (viewer deal scope): investment
   * `contact_id` equals this contact id, or a portal user with the same email.
   */
  dealCount?: number
  /** Persisted provenance for how this CRM contact entered the database. */
  importSource?: ContactImportSource
  /** Present when the row is sourced from GoHighLevel CRM */
  source?: ContactSource
  /** GoHighLevel contact id when `source` is `ghl` */
  ghlId?: string
  /** GHL rows are read-only in SyndicationX */
  readOnly?: boolean
  /** Original GHL lead source label */
  ghlSource?: string
  companyName?: string
  address?: string
  city?: string
  state?: string
  country?: string
  postalCode?: string
  website?: string
  timezone?: string
  assignedTo?: string
  contactType?: string
  customFields?: Array<{ label: string; value: string }>
  updatedAt?: string
}

/**
 * Tag shown on self-registered investors listed inside an organization's CRM.
 * Derived on read — never persisted on `contact.tags`.
 */
export const PLATFORM_CONTACT_TAG = "Platform Contact"

/** Info-icon text on the Platform Contacts group in deal member / investor pickers. */
export const PLATFORM_CONTACTS_PICKER_HINT =
  "These contacts belong to the platform — investors who signed up individually."

/** Self-registered investor row (owned by the investor, not by the org CRM). */
export function isPlatformDirectoryContact(row: ContactRow): boolean {
  return row.platformAdminOnly === true
}

/** Adds the derived Platform Contact tag for display. */
export function withPlatformContactTag(row: ContactRow): ContactRow {
  if (!isPlatformDirectoryContact(row)) return row
  const target = PLATFORM_CONTACT_TAG.toLowerCase()
  if (row.tags.some((t) => t.trim().toLowerCase() === target)) return row
  return { ...row, tags: [...row.tags, PLATFORM_CONTACT_TAG] }
}

/** Company shown in the platform-admin contacts filter, with its contact count. */
export interface ContactOrganizationOption {
  organizationId: string
  name: string
  contactCount: number
}

/** Sponsor the viewer may assign as a contact owner (org / role scoped). */
export interface ContactOwnerSponsorOption {
  userId: string
  displayName: string
  email: string
}

/** Payload for creating a contact from Add contact (invitation flag is create-only). */
export type AddContactSavePayload = Omit<
  ContactRow,
  "id" | "createdByDisplayName"
> & {
  sendInvitationMail?: "yes" | "no"
}
