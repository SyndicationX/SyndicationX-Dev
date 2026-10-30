import { CalendarClock, Mail } from "lucide-react"
import { ViewReadonlyField } from "../../../common/components/ViewReadonlyField"
import { formatDateDdMmmYyyy } from "../../../common/utils/formatDateDisplay"
import { memberInvitationAt, memberInvitationStatus } from "./memberAdminShared"

function invitationDateTime(row: Record<string, unknown>): string {
  const raw = memberInvitationAt(row)
  if (raw == null || raw === "") return "—"
  const date = formatDateDdMmmYyyy(raw)
  const parsed = raw instanceof Date ? raw : new Date(String(raw))
  if (Number.isNaN(parsed.getTime()) || date === "—") return date
  const time = parsed.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  return `${date} ${time}`
}

function InvitationStatus({ row }: { row: Record<string, unknown> }) {
  const { positive, label, dotTone } = memberInvitationStatus(row)
  const dotClass =
    dotTone === "invited"
      ? "um_status_dot um_status_dot_invited"
      : positive
        ? "um_status_dot um_status_dot_active"
        : "um_status_dot um_status_dot_inactive"
  return (
    <span className="um_status_cell">
      <span className={dotClass} aria-hidden />
      <span className="um_status_label">{label}</span>
    </span>
  )
}

/** Invitation block on the member details view. */
export function MemberInvitationSection({
  row,
}: {
  row: Record<string, unknown>
}) {
  return (
    <section className="um_view_invitation" aria-label="Invitation information">
      <h4 className="um_view_section_label">Invitation information</h4>
      <div className="um_view_grid">
        <ViewReadonlyField
          Icon={CalendarClock}
          label="Invitation date"
          value={invitationDateTime(row)}
        />
        <ViewReadonlyField
          Icon={Mail}
          label="Invitation status"
          value={<InvitationStatus row={row} />}
        />
      </div>
    </section>
  )
}
