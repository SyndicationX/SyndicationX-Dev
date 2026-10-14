import { Building2 } from "lucide-react";
import {
  organizationLabelsForCompanyScope,
  parseOrganizationLabelsFromRow,
  type OrganizationDisplayScope,
} from "./memberAdminShared";

function OrganizationNameBadge({ name }: { name: string }) {
  return (
    <span className="um_org_badge" title={name}>
      <Building2
        className="um_org_badge_icon"
        size={15}
        strokeWidth={2}
        aria-hidden
      />
      <span className="um_org_badge_label">{name}</span>
    </span>
  );
}

export function UserOrganizationsCell({
  row,
  organizationScope,
}: {
  row: Record<string, unknown>;
  organizationScope?: OrganizationDisplayScope | null;
}) {
  const orgs = organizationScope?.companyId
    ? organizationLabelsForCompanyScope(row, organizationScope)
    : parseOrganizationLabelsFromRow(row);
  if (orgs.length === 0) {
    return <span className="um_status_muted">—</span>;
  }
  if (orgs.length === 1) {
    return <OrganizationNameBadge name={orgs[0]} />;
  }
  return (
    <div className="um_org_badges">
      {orgs.map((c, i) => (
        <OrganizationNameBadge key={`${c}-${i}`} name={c} />
      ))}
    </div>
  );
}
