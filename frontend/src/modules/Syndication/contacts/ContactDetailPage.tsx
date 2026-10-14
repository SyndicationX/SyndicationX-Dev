import {
  Activity,
  Briefcase,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  StickyNote,
  Tag,
  UserRound,
  Users,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { formatUsPhoneStoredForUi } from "../../../common/phone/usPhoneNumber"
import {
  displayEmail,
  isDisplayableEmail,
} from "../../../common/utils/displayEmail"
import { isPlatformAdmin } from "../../../common/auth/roleUtils"
import { DealAvatarIconRing } from "../../../common/components/entity-avatar/EntityAvatarNameCell"
import {
  DataTable,
  type DataTableColumn,
} from "../../../common/components/data-table/DataTable"
import { TabsScrollStrip } from "../../../common/components/tabs-scroll-strip/TabsScrollStrip"
import { toast } from "../../../common/components/Toast"
import { investorRoleLabel } from "../Deals/constants/investor-profile"
import { fetchContact, fetchContactDeals } from "./api/contactsApi"
import {
  withPlatformContactTag,
  type ContactDealRow,
  type ContactRow,
} from "./types/contact.types"
import "../Deals/deals-list.css"
import "./contacts.css"
import "./contact-detail.css"

type MainTab = "activities" | "referrals" | "deals"
type ActivityFilter =
  | "all"
  | "notes"
  | "emails"
  | "changelog"
  | "pipelines"
  | "automations"
  | "tasks"
  | "meetings"
  | "texts"

type SidebarSectionId =
  | "details"
  | "address"
  | "custom"
  | "additional"
  | "utm"

type ActivityItem = {
  id: string
  kind: "email" | "note" | "changelog"
  title: string
  subject?: string
  at: string
}

const ACTIVITY_FILTERS: ReadonlyArray<{
  id: ActivityFilter
  label: string
  isNew?: boolean
}> = [
  { id: "all", label: "All" },
  { id: "notes", label: "Notes" },
  { id: "emails", label: "Emails" },
  { id: "changelog", label: "Changelog" },
  { id: "pipelines", label: "Pipelines" },
  { id: "automations", label: "Automations" },
  { id: "tasks", label: "Tasks" },
  { id: "meetings", label: "Meetings" },
  { id: "texts", label: "Texts" },
]

const SIDEBAR_SECTIONS: ReadonlyArray<{
  id: SidebarSectionId
  label: string
  help?: boolean
}> = [
  { id: "details", label: "Contact details" },
  { id: "address", label: "Contact address" },
  { id: "custom", label: "Custom attributes", help: true },
  { id: "additional", label: "Additional details" },
  { id: "utm", label: "UTM tracking" },
]

function initialsFromContact(row: ContactRow): string {
  const first = row.firstName.trim()
  const last = row.lastName.trim()
  if (first && last) return (first[0] + last[0]).toUpperCase()
  if (first.length >= 1) return first[0].toUpperCase()
  const e = row.email.trim()
  if (e.length >= 1) return e[0].toUpperCase()
  return "?"
}

function contactDisplayName(row: ContactRow): string {
  const n = [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
  return n || "—"
}

function formatActivityTimestamp(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ""
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "shortOffset",
    }).format(d)
  } catch {
    return d.toLocaleString()
  }
}

function monthYearLabel(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return "Unknown"
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
    }).format(d)
  } catch {
    return d.toLocaleDateString()
  }
}

function buildActivities(contact: ContactRow): ActivityItem[] {
  const items: ActivityItem[] = []
  if (contact.createdAt) {
    items.push({
      id: `welcome-${contact.id}`,
      kind: "email",
      title: "System email",
      subject: "Welcome to SyndicationX",
      at: contact.createdAt,
    })
  }
  if (contact.lastEditReason?.trim() && contact.updatedAt) {
    items.push({
      id: `edit-${contact.id}`,
      kind: "changelog",
      title: "Contact updated",
      subject: contact.lastEditReason.trim(),
      at: contact.updatedAt,
    })
  } else if (contact.lastEditReason?.trim() && contact.createdAt) {
    items.push({
      id: `edit-${contact.id}`,
      kind: "changelog",
      title: "Contact updated",
      subject: contact.lastEditReason.trim(),
      at: contact.createdAt,
    })
  }
  if (contact.note?.trim()) {
    items.push({
      id: `note-${contact.id}`,
      kind: "note",
      title: "Note",
      subject: contact.note.trim(),
      at: contact.updatedAt || contact.createdAt || new Date().toISOString(),
    })
  }
  return items.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  )
}

const DEAL_LAST_WENT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** `11-Oct-2026`. Empty when the contact has never opened the deal. */
function formatDealLastWent(iso: string | null): string {
  if (!iso?.trim()) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return `${date.getDate()}-${DEAL_LAST_WENT_MONTHS[date.getMonth()]}-${date.getFullYear()}`
}

const CONTACT_DEAL_COLUMNS: DataTableColumn<ContactDealRow>[] = [
  {
    id: "dealName",
    header: "Deal name",
    sortValue: (row) => row.dealName.toLowerCase(),
    cell: (row) => {
      const name = row.dealName.trim() || "—"
      const dealId = row.dealId.trim()
      return (
        <div className="deals_list_name_cell">
          <DealAvatarIconRing />
          <div className="deals_list_name_text">
            {dealId ? (
              <Link
                className="deals_table_name_link"
                to={`/deals/${encodeURIComponent(dealId)}`}
              >
                {name}
              </Link>
            ) : (
              name
            )}
          </div>
        </div>
      )
    },
  },
  {
    id: "contactRole",
    header: "Contact role",
    sortValue: (row) => investorRoleLabel(row.contactRole).toLowerCase(),
    cell: (row) => investorRoleLabel(row.contactRole),
  },
  {
    id: "dealOrganization",
    header: "Deal organization",
    sortValue: (row) => row.dealOrganization.toLowerCase(),
    cell: (row) => row.dealOrganization.trim() || "—",
  },
  {
    id: "lastWentAt",
    header: "Last visit",
    sortValue: (row) => {
      if (!row.lastWentAt) return 0
      const time = new Date(row.lastWentAt).getTime()
      return Number.isNaN(time) ? 0 : time
    },
    cell: (row) => formatDealLastWent(row.lastWentAt),
  },
]

function ContactDetailPage() {
  const { contactId = "" } = useParams<{ contactId: string }>()
  const navigate = useNavigate()
  const platformAdmin = isPlatformAdmin()
  const [contact, setContact] = useState<ContactRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [mainTab, setMainTab] = useState<MainTab>("activities")
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all")
  const [openSections, setOpenSections] = useState<
    Partial<Record<SidebarSectionId, boolean>>
  >({})
  const [moreOpen, setMoreOpen] = useState(false)
  const [contactDeals, setContactDeals] = useState<ContactDealRow[]>([])
  const [dealsLoading, setDealsLoading] = useState(false)
  const [dealsError, setDealsError] = useState("")

  const load = useCallback(async () => {
    const id = contactId.trim()
    if (!id) {
      setContact(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const row = await fetchContact(id)
      setContact(row ? withPlatformContactTag(row) : row)
      if (!row) toast.error("Not found", "This contact could not be loaded.")
    } catch {
      setContact(null)
      toast.error("Could not load contact", "Try again.")
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!platformAdmin || mainTab !== "deals") return
    const id = contactId.trim()
    if (!id) return
    let cancelled = false
    setDealsLoading(true)
    setDealsError("")
    void fetchContactDeals(id)
      .then((rows) => {
        if (!cancelled) setContactDeals(rows)
      })
      .catch(() => {
        if (!cancelled) {
          setContactDeals([])
          setDealsError("Could not load deals for this contact.")
        }
      })
      .finally(() => {
        if (!cancelled) setDealsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformAdmin, mainTab, contactId])

  const activities = useMemo(
    () => (contact ? buildActivities(contact) : []),
    [contact],
  )

  const filteredActivities = useMemo(() => {
    if (activityFilter === "all") return activities
    if (activityFilter === "emails")
      return activities.filter((a) => a.kind === "email")
    if (activityFilter === "notes")
      return activities.filter((a) => a.kind === "note")
    if (activityFilter === "changelog")
      return activities.filter((a) => a.kind === "changelog")
    return []
  }, [activities, activityFilter])

  const groupedActivities = useMemo(() => {
    const map = new Map<string, ActivityItem[]>()
    for (const item of filteredActivities) {
      const key = monthYearLabel(item.at)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [filteredActivities])

  function toggleSection(id: SidebarSectionId) {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  if (loading) {
    return (
      <section className="cd_page" aria-busy="true">
        <div className="cd_loading">
          <Loader2 className="cd_spin" size={22} aria-hidden />
          <span>Loading contact…</span>
        </div>
      </section>
    )
  }

  if (!contact) {
    return (
      <section className="cd_page">
        <div className="cd_empty_state">
          <p>Contact not found.</p>
          <Link to="/contacts" className="cd_back_link">
            Back to contacts
          </Link>
        </div>
      </section>
    )
  }

  const displayName = contactDisplayName(contact)
  const phoneShown = formatUsPhoneStoredForUi(contact.phone)
  const email = contact.email.trim()
  const isActive = contact.status !== "suspended"
  const filterLabel =
    ACTIVITY_FILTERS.find((f) => f.id === activityFilter)?.label ?? "All"

  return (
    <section className="cd_page">
      <aside className="cd_sidebar" aria-label="Contact summary">
        <div className="cd_sidebar_top">
          <button
            type="button"
            className="cd_back_btn"
            onClick={() => navigate("/contacts")}
          >
            <ChevronRight
              size={16}
              className="cd_back_chevron"
              aria-hidden
            />
            Back
          </button>
          <div className="cd_more_wrap">
            <button
              type="button"
              className="cd_more_btn"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((v) => !v)}
            >
              More
              <ChevronDown size={14} aria-hidden />
            </button>
            {moreOpen ? (
              <div className="cd_more_menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
                    navigate("/contacts")
                  }}
                >
                  Back to list
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="cd_identity">
          <div className="cd_avatar" aria-hidden>
            {initialsFromContact(contact)}
          </div>
          <h1 className="cd_name">{displayName}</h1>
          {isDisplayableEmail(email) ? (
            <a href={`mailto:${encodeURIComponent(email)}`} className="cd_email">
              {email}
            </a>
          ) : (
            <span className="cd_email cd_muted">{displayEmail(email)}</span>
          )}
          <p className="cd_phone">{phoneShown || "—"}</p>
          <span
            className={`cd_status_badge${isActive ? "" : " cd_status_badge--muted"}`}
          >
            {isActive ? (
              <CheckCircle2 size={14} aria-hidden />
            ) : null}
            {isActive ? "Signed up" : "Suspended"}
          </span>
        </div>

        <div className="cd_quick_actions" aria-label="Quick actions">
          <button type="button" className="cd_action_icon" title="Note" aria-label="Note">
            <StickyNote size={18} aria-hidden />
          </button>
          <button type="button" className="cd_action_icon" title="Email" aria-label="Email">
            <Mail size={18} aria-hidden />
          </button>
          <button type="button" className="cd_action_icon" title="Task" aria-label="Task">
            <FileText size={18} aria-hidden />
          </button>
          <button type="button" className="cd_action_icon" title="Meeting" aria-label="Meeting">
            <Calendar size={18} aria-hidden />
          </button>
          <button type="button" className="cd_action_icon" title="Tag" aria-label="Tag">
            <Tag size={18} aria-hidden />
          </button>
          <button type="button" className="cd_action_icon" title="More" aria-label="More actions">
            <MoreHorizontal size={18} aria-hidden />
          </button>
        </div>

        <div className="cd_meta_block">
          <h2 className="cd_meta_heading">Pipelines</h2>
          <p className="cd_meta_empty">No pipelines</p>
        </div>
        <div className="cd_meta_block">
          <h2 className="cd_meta_heading">Automations</h2>
          <p className="cd_meta_empty">No automations</p>
        </div>
        <div className="cd_meta_block">
          <h2 className="cd_meta_heading">Contact tags</h2>
          {contact.tags.length ? (
            <div className="cd_chip_row">
              {contact.tags.map((t) => (
                <span key={t} className="cd_chip">
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <p className="cd_meta_empty">No contact tags</p>
          )}
        </div>
        <div className="cd_meta_block">
          <h2 className="cd_meta_heading">Lists</h2>
          {contact.lists.length ? (
            <div className="cd_chip_row">
              {contact.lists.map((t) => (
                <span key={t} className="cd_chip">
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <p className="cd_meta_empty">No lists</p>
          )}
        </div>

        <div className="cd_accordions">
          {SIDEBAR_SECTIONS.map((sec) => {
            const open = Boolean(openSections[sec.id])
            return (
              <div key={sec.id} className="cd_accordion">
                <button
                  type="button"
                  className="cd_accordion_btn"
                  aria-expanded={open}
                  onClick={() => toggleSection(sec.id)}
                >
                  <span className="cd_accordion_label">
                    {sec.label}
                    {sec.help ? (
                      <CircleHelp size={14} className="cd_help_icon" aria-hidden />
                    ) : null}
                  </span>
                  <ChevronRight
                    size={16}
                    className={`cd_accordion_chevron${open ? " is-open" : ""}`}
                    aria-hidden
                  />
                </button>
                {open ? (
                  <div className="cd_accordion_body">
                    {sec.id === "details" ? (
                      <dl className="cd_detail_dl">
                        <div>
                          <dt>Owners</dt>
                          <dd>
                            {contact.owners.length
                              ? contact.owners.join(", ")
                              : "—"}
                          </dd>
                        </div>
                        <div>
                          <dt>Invited by</dt>
                          <dd>{contact.invitedByDisplayName?.trim() || "—"}</dd>
                        </div>
                        {platformAdmin ? (
                          <div>
                            <dt>Visible on platform</dt>
                            <dd>
                              {contact.visibleToUsers === true ? "Yes" : "No"}
                            </dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>Added by</dt>
                          <dd>{contact.createdByDisplayName?.trim() || "—"}</dd>
                        </div>
                        <div>
                          <dt>Deals</dt>
                          <dd>{contact.dealCount ?? 0}</dd>
                        </div>
                      </dl>
                    ) : sec.id === "address" ? (
                      <p className="cd_meta_empty">No address on file</p>
                    ) : sec.id === "additional" ? (
                      <dl className="cd_detail_dl">
                        <div>
                          <dt>Note</dt>
                          <dd>{contact.note?.trim() || "—"}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="cd_meta_empty">Nothing here yet</p>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </aside>

      <div className="cd_main">
        <div className="cd_main_header">
          <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer cd_primary_tabs_outer">
            <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
              <div
                className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row"
                role="tablist"
                aria-label="Contact sections"
              >
                <button
                  type="button"
                  id="cd-main-tab-activities"
                  role="tab"
                  aria-selected={mainTab === "activities"}
                  aria-controls="cd-main-panel-activities"
                  className={`um_members_tab deals_tabs_tab um_segmented_tab${
                    mainTab === "activities" ? " um_members_tab_active" : ""
                  }`}
                  onClick={() => setMainTab("activities")}
                >
                  <Activity
                    className="deals_tabs_icon um_segmented_tab_icon"
                    size={16}
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span className="deals_tabs_label um_segmented_tab_label">
                    Activities
                  </span>
                </button>
                <button
                  type="button"
                  id="cd-main-tab-referrals"
                  role="tab"
                  aria-selected={mainTab === "referrals"}
                  aria-controls="cd-main-panel-referrals"
                  className={`um_members_tab deals_tabs_tab um_segmented_tab${
                    mainTab === "referrals" ? " um_members_tab_active" : ""
                  }`}
                  onClick={() => setMainTab("referrals")}
                >
                  <Users
                    className="deals_tabs_icon um_segmented_tab_icon"
                    size={16}
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span className="deals_tabs_label um_segmented_tab_label">
                    Referrals
                  </span>
                </button>
                {platformAdmin ? (
                  <button
                    type="button"
                    id="cd-main-tab-deals"
                    role="tab"
                    aria-selected={mainTab === "deals"}
                    aria-controls="cd-main-panel-deals"
                    className={`um_members_tab deals_tabs_tab um_segmented_tab${
                      mainTab === "deals" ? " um_members_tab_active" : ""
                    }`}
                    onClick={() => setMainTab("deals")}
                  >
                    <Briefcase
                      className="deals_tabs_icon um_segmented_tab_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <span className="deals_tabs_label um_segmented_tab_label">
                      Deals
                    </span>
                  </button>
                ) : null}
              </div>
            </TabsScrollStrip>
          </div>
          {/* <a
            className="cd_demo_link"
            href="https://www.cashflowportal.com"
            target="_blank"
            rel="noreferrer"
          >
            Schedule a demo
          </a> */}
        </div>

        {mainTab === "deals" && platformAdmin ? (
          <div
            id="cd-main-panel-deals"
            role="tabpanel"
            aria-labelledby="cd-main-tab-deals"
            className="cd_feed cd_deals_panel"
          >
            <h2 className="cd_feed_title">Deals</h2>
            {dealsError ? (
              <p className="cd_feed_empty" role="alert">
                {dealsError}
              </p>
            ) : (
              <DataTable<ContactDealRow>
                columns={CONTACT_DEAL_COLUMNS}
                rows={contactDeals}
                getRowKey={(row) => row.dealId}
                emptyLabel="No deals for this contact."
                visualVariant="members"
                membersShell="plain"
                stickyFirstColumn={false}
                isLoading={dealsLoading}
                initialSort={{ columnId: "dealName", direction: "asc" }}
              />
            )}
          </div>
        ) : mainTab === "activities" ? (
          <>
            <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer cd_activity_filters_outer">
              <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
                <div
                  className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row"
                  role="tablist"
                  aria-label="Activity filters"
                >
                  {ACTIVITY_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      id={`cd-activity-filter-${f.id}`}
                      role="tab"
                      aria-selected={activityFilter === f.id}
                      className={`um_members_tab deals_tabs_tab um_segmented_tab${
                        activityFilter === f.id ? " um_members_tab_active" : ""
                      }`}
                      onClick={() => setActivityFilter(f.id)}
                    >
                      <span className="deals_tabs_label um_segmented_tab_label">
                        {f.label}
                      </span>
                      {f.isNew ? (
                        <span className="cd_new_badge" aria-label="New">
                          New
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </TabsScrollStrip>
            </div>

            <div
              id="cd-main-panel-activities"
              role="tabpanel"
              aria-labelledby="cd-main-tab-activities"
              className="cd_feed"
            >
              <h2 className="cd_feed_title">
                {activityFilter === "all"
                  ? "All activities"
                  : `${filterLabel} activities`}
              </h2>

              {groupedActivities.length === 0 ? (
                <p className="cd_feed_empty">No activities in this view.</p>
              ) : (
                groupedActivities.map(([month, items]) => (
                  <div key={month} className="cd_feed_group">
                    <h3 className="cd_feed_month">{month}</h3>
                    <ul className="cd_feed_list">
                      {items.map((item) => (
                        <li key={item.id} className="cd_activity_card">
                          <div className="cd_activity_card_top">
                            <span className="cd_activity_title">{item.title}</span>
                            <time
                              className="cd_activity_time"
                              dateTime={item.at}
                            >
                              {formatActivityTimestamp(item.at)}
                            </time>
                          </div>
                          {item.subject ? (
                            <p className="cd_activity_subject">
                              Subject:{" "}
                              <span className="cd_activity_subject_link">
                                {item.subject}
                              </span>
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}

              <p className="cd_feed_end">No more activities.</p>
            </div>
          </>
        ) : (
          <div
            id="cd-main-panel-referrals"
            role="tabpanel"
            aria-labelledby="cd-main-tab-referrals"
            className="cd_feed"
          >
            <div className="cd_referrals_empty">
              <UserRound size={28} aria-hidden />
              <p>No referrals yet for this contact.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default ContactDetailPage
