import { useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"
import { Building2, X } from "lucide-react"
import "../../Deals/tabs/investors/add-investment-modal.css"
import "../../usermanagement/user_management.css"
import "../contacts.css"
import type { ContactOrganizationSummary, ContactRow } from "../types/contact.types"

function formatDealRole(role: string): string {
  const raw = role.trim()
  if (!raw) return ""
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function fallbackCompanies(row: ContactRow): ContactOrganizationSummary[] {
  const name = row.organizationName?.trim() || row.addedByCompanyName?.trim() || ""
  if (!name) return []
  return [
    {
      companyId: row.organizationId?.trim() || "",
      companyName: name,
      deals: [],
    },
  ]
}

type OrganizationTableRow = {
  key: string
  companyName: string
  dealName: string
  role: string
  showCompany: boolean
  companyRowSpan: number
}

function organizationTableRows(
  companies: ContactOrganizationSummary[],
): OrganizationTableRow[] {
  const rows: OrganizationTableRow[] = []
  companies.forEach((company, companyIndex) => {
    const companyKey = company.companyId || company.companyName || String(companyIndex)
    const deals = company.deals.length > 0 ? company.deals : [null]
    deals.forEach((deal, dealIndex) => {
      const role = deal ? formatDealRole(deal.contactRole) : ""
      rows.push({
        key: `${companyKey}:${deal?.dealId || deal?.dealName || "none"}:${dealIndex}`,
        companyName: company.companyName,
        dealName: deal?.dealName?.trim() || "—",
        role: role || "—",
        showCompany: dealIndex === 0,
        companyRowSpan: deals.length,
      })
    })
  })
  return rows
}

function contactPersonName(row: ContactRow): string {
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
  return name || row.email.trim() || "Contact"
}

function CompaniesDialog({
  personName,
  companies,
  onClose,
}: {
  personName: string
  companies: ContactOrganizationSummary[]
  onClose: () => void
}) {
  const titleId = useId()
  const companyCountLabel =
    companies.length === 1 ? "1 company" : `${companies.length} companies`
  const rows = organizationTableRows(companies)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      className="um_modal_overlay portal_modal_z_boost contacts_view_modal_overlay"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="um_modal um_modal_view deals_add_inv_modal_panel contacts_view_modal contacts_org_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="um_modal_head">
          <h3 id={titleId} className="um_modal_title">
            Companies
          </h3>
          <button
            type="button"
            className="um_modal_close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <p className="um_modal_desc contacts_org_intro">
          <span className="contacts_org_intro_name">{personName}</span>
          <span className="contacts_org_intro_meta">{companyCountLabel}</span>
        </p>
        <div className="deals_add_inv_modal_scroll contacts_org_panel_body">
          <div className="um_table_wrap contacts_org_table_wrap">
            <table className="um_table contacts_org_table">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Deal</th>
                  <th scope="col">Role</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    {row.showCompany ? (
                      <td
                        className="contacts_org_table_company"
                        rowSpan={row.companyRowSpan > 1 ? row.companyRowSpan : undefined}
                      >
                        {row.companyName}
                      </td>
                    ) : null}
                    <td className={row.dealName === "—" ? "contacts_org_table_muted" : undefined}>
                      {row.dealName}
                    </td>
                    <td className={row.role === "—" ? "contacts_org_table_muted" : undefined}>
                      {row.role}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="um_modal_actions um_modal_actions_view contacts_view_modal_footer">
          <button type="button" className="um_btn_secondary" onClick={onClose}>
            <X size={16} strokeWidth={2} aria-hidden />
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function CompanyBadge({ name }: { name: string }) {
  return (
    <span className="um_org_badge" title={name}>
      <Building2 className="um_org_badge_icon" size={15} strokeWidth={2} aria-hidden />
      <span className="um_org_badge_label">{name}</span>
    </span>
  )
}

/** Organization column: every company, or the first name plus a count. */
export function ContactOrganizationsCell({ row }: { row: ContactRow }) {
  const [open, setOpen] = useState(false)
  const personName = contactPersonName(row)
  const companies = Array.isArray(row.organizations)
    ? row.organizations
    : fallbackCompanies(row)

  if (companies.length === 0) {
    return <span className="um_status_muted">—</span>
  }

  if (companies.length === 1) {
    return (
      <>
        <button
          type="button"
          className="contacts_org_cell contacts_org_cell_button"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
          title="View company and deals"
        >
          <CompanyBadge name={companies[0].companyName} />
        </button>
        {open ? (
          <CompaniesDialog
            personName={personName}
            companies={companies}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    )
  }

  if (companies.length === 2) {
    return (
      <>
        <button
          type="button"
          className="contacts_org_cell contacts_org_cell_button"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
          title="View companies and deals"
        >
          <CompanyBadge name={companies[0].companyName} />
          <CompanyBadge name={companies[1].companyName} />
        </button>
        {open ? (
          <CompaniesDialog
            personName={personName}
            companies={companies}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    )
  }

  const extra = companies.length - 1
  return (
    <>
      <span className="contacts_org_cell">
        <button
          type="button"
          className="contacts_org_cell_button"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
          title="View companies and deals"
        >
          <CompanyBadge name={companies[0].companyName} />
        </button>
        <button
          type="button"
          className="contacts_org_more"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${extra} more ${extra === 1 ? "company" : "companies"}`}
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
        >
          +{extra}
        </button>
      </span>
      {open ? (
        <CompaniesDialog
          personName={personName}
          companies={companies}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
