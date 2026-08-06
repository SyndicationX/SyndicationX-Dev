export type ContactStatus = "active" | "suspended"

export type ContactSource = "local" | "ghl"

/** Per-contact offering visibility on the investor portal. */
export type ContactShowOfferings = "show" | "506c" | "hide"

export const CONTACT_SHOW_OFFERINGS_OPTIONS: ReadonlyArray<{
  value: ContactShowOfferings
  label: string
}> = [
  { value: "show", label: "Show offerings" },
  { value: "506c", label: "Show only 506c offerings" },
  { value: "hide", label: "Hide offerings" },
]

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
  /** Offering visibility for this contact (default `show`) */
  showOfferings?: ContactShowOfferings
  /** Text from the most recent edit (required when saving edits) */
  lastEditReason?: string
  /** Resolved display name for the user who created the row (from API) */
  createdByDisplayName?: string
  /** ISO timestamp when the contact was created (from API) */
  createdAt?: string
  /**
   * Distinct deals linked to this contact (viewer deal scope): investment
   * `contact_id` equals this contact id, or a portal user with the same email.
   */
  dealCount?: number
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