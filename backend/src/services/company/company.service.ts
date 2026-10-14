import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, pool } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { addDealForm } from "../../schema/deal.schema/add-deal-form.schema.js";
import {
  companies,
  companyAdminAuditLogs,
  contact,
  type CompanyRow,
} from "../../schema/schema.js";
import { ORG_DIRECTORY_MEMBER_ROLES } from "../../constants/roles.js";
import {
  provisionGhlLocationForCompany,
  queueGhlLocationProvision,
} from "../ghl/ghlLocation.service.js";
import {
  isGhlPerOrgLocationsEnabled,
} from "../../config/ghl.config.js";

const ORG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COMPANY_AUDIT_ACTION_EDIT = "company_edit";
export const COMPANY_AUDIT_ACTION_SUSPEND = "company_suspend";

export type CompanyAuditAction =
  | typeof COMPANY_AUDIT_ACTION_EDIT
  | typeof COMPANY_AUDIT_ACTION_SUSPEND;

export type CompanyWithStats = {
  id: string;
  name: string;
  status: string;
  ghlLocationId: string | null;
  ghlLocationStatus: string;
  ghlLocationError: string | null;
  ghlLocationProvisionedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  userCount: number;
  dealCount: number;
  /**
   * Company CRM contacts: `organization_id` matches, plus legacy rows with no
   * organization whose creator belongs to the company. Platform-only contacts
   * are excluded.
   */
  contactCount: number;
};

export const COMPANY_NAME_TAKEN_MESSAGE =
  "A company with this name already exists";

function normalizeCompanyNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Case-insensitive, trimmed match against `companies.name`. */
export async function isCompanyNameTaken(
  rawName: string,
  excludeCompanyId?: string,
): Promise<boolean> {
  const norm = normalizeCompanyNameKey(rawName);
  if (!norm) return false;
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      excludeCompanyId
        ? and(
            sql`lower(trim(${companies.name})) = ${norm}`,
            ne(companies.id, excludeCompanyId),
          )
        : sql`lower(trim(${companies.name})) = ${norm}`,
    )
    .limit(1);
  return Boolean(row);
}

function isMissingMembershipTableError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4; i += 1) {
    if (!cur || typeof cur !== "object") break;
    const e = cur as { code?: string; message?: string; cause?: unknown };
    if (e.code === "42P01") return true;
    const msg = String(e.message ?? "").toLowerCase();
    if (msg.includes('relation "user_company_membership" does not exist')) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Distinct org-staff members per company — same population as
 * `GET /users?organizationId=…` (Members tab), not every portal user with
 * `users.organization_id` (investors / deal participants are excluded).
 */
async function loadOrgMemberCountsByCompanyId(): Promise<Map<string, number>> {
  const staffRoles = [...ORG_DIRECTORY_MEMBER_ROLES];
  const map = new Map<string, number>();
  const applyRows = (rows: { company_id: string; cnt: number }[]) => {
    for (const r of rows) {
      const id = String(r.company_id ?? "").trim();
      if (id) map.set(id, Number(r.cnt) || 0);
    }
  };

  const fallbackSql = `
    SELECT u.organization_id::text AS company_id, COUNT(*)::int AS cnt
    FROM users u
    WHERE u.organization_id IS NOT NULL
      AND u.role = ANY($1::text[])
    GROUP BY u.organization_id`;

  try {
    const res = await pool.query<{ company_id: string; cnt: number }>(
      `SELECT company_id::text AS company_id, COUNT(*)::int AS cnt
       FROM (
         SELECT u.organization_id AS company_id, u.id AS user_id
         FROM users u
         WHERE u.organization_id IS NOT NULL
           AND u.role = ANY($1::text[])
         UNION
         SELECT m.company_id, u.id
         FROM user_company_membership m
         INNER JOIN users u ON u.id = m.user_id
         WHERE u.role = ANY($1::text[])
           AND m.role = ANY($1::text[])
       ) members
       GROUP BY company_id`,
      [staffRoles],
    );
    applyRows(res.rows);
  } catch (err) {
    if (!isMissingMembershipTableError(err)) throw err;
    const res = await pool.query<{ company_id: string; cnt: number }>(
      fallbackSql,
      [staffRoles],
    );
    applyRows(res.rows);
  }
  return map;
}

/**
 * Ensures a `companies` row exists for the given `users.organization_id` (same UUID).
 * Use when a platform admin’s org should appear in the company directory but the row
 * is missing (legacy data, or admin created before the company was inserted).
 */
export async function ensureCompanyRowForOrganizationId(
  organizationId: string,
  nameHint: string,
): Promise<void> {
  const oid = String(organizationId ?? "").trim();
  if (!oid || !ORG_UUID_RE.test(oid)) return;
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, oid))
    .limit(1);
  if (existing) return;
  const rawName = String(nameHint ?? "").trim();
  const name =
    rawName.length > 0
      ? rawName.slice(0, 255)
      : "Organization";
  const now = new Date();
  try {
    await db
      .insert(companies)
      .values({
        id: oid,
        name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: companies.id });
    queueGhlLocationProvision(oid);
  } catch (err) {
    console.error("ensureCompanyRowForOrganizationId:", err);
  }
}

export async function listCompanies(): Promise<CompanyWithStats[]> {
  /**
   * Counts use grouped queries (not correlated subqueries) so they stay aligned
   * with list APIs: `GET /users?organizationId=…` (org staff Members tab),
   * `GET /deals?organizationId=…`.
   * Legacy deals may still be keyed by `owning_entity_name` when `organization_id` is null.
   */
  const [
    rows,
    byOrgId,
    orgDealCounts,
    legacyDealNameCounts,
    orgContactCounts,
    legacyMemberContactCounts,
  ] = await Promise.all([
    db
      .select({
        id: companies.id,
        name: companies.name,
        status: companies.status,
        ghlLocationId: companies.ghlLocationId,
        ghlLocationStatus: companies.ghlLocationStatus,
        ghlLocationError: companies.ghlLocationError,
        ghlLocationProvisionedAt: companies.ghlLocationProvisionedAt,
        createdAt: companies.createdAt,
        updatedAt: companies.updatedAt,
      })
      .from(companies)
      .orderBy(desc(companies.createdAt)),
    loadOrgMemberCountsByCompanyId(),
    db
      .select({
        organizationId: addDealForm.organizationId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(addDealForm)
      .where(isNotNull(addDealForm.organizationId))
      .groupBy(addDealForm.organizationId),
    db
      .select({
        nameNorm: sql<string>`lower(trim(${addDealForm.owningEntityName}))`,
        cnt: sql<number>`count(*)::int`,
      })
      .from(addDealForm)
      .where(isNull(addDealForm.organizationId))
      .groupBy(sql`lower(trim(${addDealForm.owningEntityName}))`),
    db
      .select({
        organizationId: contact.organizationId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(contact)
      .where(
        and(
          isNotNull(contact.organizationId),
          eq(contact.platformAdminOnly, false),
        ),
      )
      .groupBy(contact.organizationId),
    db
      .select({
        organizationId: users.organizationId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(contact)
      .innerJoin(users, eq(users.id, contact.createdBy))
      .where(
        and(
          isNull(contact.organizationId),
          eq(contact.platformAdminOnly, false),
          isNotNull(users.organizationId),
        ),
      )
      .groupBy(users.organizationId),
  ]);

  const byDealOrgId = new Map<string, number>();
  for (const r of orgDealCounts) {
    const id = r.organizationId;
    if (id) byDealOrgId.set(id, Number(r.cnt));
  }

  const byLegacyDealName = new Map<string, number>();
  for (const r of legacyDealNameCounts) {
    const k = String(r.nameNorm ?? "").trim();
    if (k) byLegacyDealName.set(k, Number(r.cnt));
  }

  const byOrgContact = new Map<string, number>();
  for (const r of orgContactCounts) {
    const id = r.organizationId;
    if (id) byOrgContact.set(id, Number(r.cnt));
  }
  for (const r of legacyMemberContactCounts) {
    const id = r.organizationId;
    if (!id) continue;
    byOrgContact.set(id, (byOrgContact.get(id) ?? 0) + Number(r.cnt));
  }

  return rows.map((r) => {
    const userByOrg = byOrgId.get(r.id) ?? 0;
    const dealByOrg = byDealOrgId.get(r.id) ?? 0;
    const dealByName =
      byLegacyDealName.get(normalizeCompanyNameKey(r.name)) ?? 0;
    return {
      ...r,
      userCount: userByOrg,
      dealCount: dealByOrg + dealByName,
      contactCount: byOrgContact.get(r.id) ?? 0,
    };
  });
}

export type CompanyGhlProvisioningResult =
  | { enabled: false }
  | { enabled: true; ok: true; locationId: string }
  | { enabled: true; ok: false; message: string };

export async function createCompany(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false as const, status: 400, message: "Company name is required" };
  }
  if (await isCompanyNameTaken(trimmed)) {
    return {
      ok: false as const,
      status: 409,
      message: COMPANY_NAME_TAKEN_MESSAGE,
    };
  }
  try {
    const [row] = await db
      .insert(companies)
      .values({ name: trimmed })
      .returning();
    if (!row) {
      return {
        ok: false as const,
        status: 500,
        message: "Could not create company",
      };
    }

    let ghlProvisioning: CompanyGhlProvisioningResult = { enabled: false };
    if (isGhlPerOrgLocationsEnabled()) {
      const prov = await provisionGhlLocationForCompany(row.id);
      if (prov.ok) {
        ghlProvisioning = {
          enabled: true,
          ok: true,
          locationId: prov.locationId,
        };
      } else {
        console.warn(`[ghl-location] company ${row.id}: ${prov.message}`);
        ghlProvisioning = { enabled: true, ok: false, message: prov.message };
      }
      const [updated] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, row.id))
        .limit(1);
      return {
        ok: true as const,
        company: updated ?? row,
        ghlProvisioning,
      };
    }

    return { ok: true as const, company: row, ghlProvisioning };
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code ?? "")
        : "";
    if (code === "23505") {
      return {
        ok: false as const,
        status: 409,
        message: COMPANY_NAME_TAKEN_MESSAGE,
      };
    }
    console.error("createCompany:", err);
    return {
      ok: false as const,
      status: 500,
      message: "Could not create company",
    };
  }
}

export async function updateCompany(
  id: string,
  patch: { name?: string; status?: string },
  audit: {
    actorUserId: string;
    reason: string;
    action: CompanyAuditAction;
  },
): Promise<
  | { ok: true; company: CompanyRow }
  | { ok: false; status: number; message: string }
> {
  const [current] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  if (!current) {
    return { ok: false, status: 404, message: "Company not found" };
  }

  let nextName = current.name;
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) {
      return { ok: false, status: 400, message: "Company name is required" };
    }
    nextName = trimmed;
    if (await isCompanyNameTaken(nextName, id)) {
      return {
        ok: false,
        status: 409,
        message: COMPANY_NAME_TAKEN_MESSAGE,
      };
    }
  }

  let nextStatus = String(current.status ?? "active").trim().toLowerCase();
  if (patch.status !== undefined) {
    const s = patch.status.trim().toLowerCase();
    if (s !== "active" && s !== "suspended" && s !== "inactive") {
      return { ok: false, status: 400, message: "Invalid status" };
    }
    nextStatus = s;
  }

  const nameChanging = patch.name !== undefined && nextName !== current.name;
  const statusChanging =
    patch.status !== undefined && nextStatus !== current.status;

  if (!nameChanging && !statusChanging) {
    return { ok: false, status: 400, message: "No changes" };
  }

  if (audit.action === COMPANY_AUDIT_ACTION_SUSPEND) {
    if (nameChanging) {
      return {
        ok: false,
        status: 400,
        message: "Company suspend cannot change the company name",
      };
    }
    if (!statusChanging || nextStatus !== "inactive") {
      return {
        ok: false,
        status: 400,
        message: "Company suspend requires setting status to inactive",
      };
    }
  }

  const updates: {
    name?: string;
    status?: string;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (nameChanging) updates.name = nextName;
  if (statusChanging) updates.status = nextStatus;

  const changesJson: Record<string, { from: string; to: string }> = {};
  if (nameChanging) {
    changesJson.name = { from: current.name, to: nextName };
  }
  if (statusChanging) {
    changesJson.status = { from: current.status, to: nextStatus };
  }

  try {
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(companies)
        .set(updates)
        .where(eq(companies.id, id))
        .returning();
      if (!updated) throw new Error("update_returned_no_row");
      await tx.insert(companyAdminAuditLogs).values({
        actorUserId: audit.actorUserId,
        targetCompanyId: id,
        action: audit.action,
        reason: audit.reason,
        changesJson,
      });
      return updated;
    });
    return { ok: true, company: row };
  } catch (err) {
    if (err instanceof Error && err.message === "update_returned_no_row") {
      return { ok: false, status: 404, message: "Company not found" };
    }
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code ?? "")
        : "";
    if (code === "23505") {
      return { ok: false, status: 409, message: COMPANY_NAME_TAKEN_MESSAGE };
    }
    console.error("updateCompany:", err);
    return { ok: false, status: 500, message: "Could not update company" };
  }
}

/**
 * Workspace rename (company admin / workspace editor). No audit reason.
 * Rejects names already used by another company (case-insensitive).
 */
export async function renameCompanyDisplayName(
  id: string,
  rawName: string,
): Promise<
  | { ok: true; company: CompanyRow; changed: boolean }
  | { ok: false; status: number; message: string }
> {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { ok: false, status: 400, message: "Company name is required" };
  }
  const [current] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  if (!current) {
    return { ok: false, status: 404, message: "Company not found" };
  }
  if (current.name === trimmed) {
    return { ok: true, company: current, changed: false };
  }
  if (await isCompanyNameTaken(trimmed, id)) {
    return {
      ok: false,
      status: 409,
      message: COMPANY_NAME_TAKEN_MESSAGE,
    };
  }
  try {
    const [updated] = await db
      .update(companies)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(companies.id, id))
      .returning();
    if (!updated) {
      return { ok: false, status: 404, message: "Company not found" };
    }
    return { ok: true, company: updated, changed: true };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code ?? "")
        : "";
    if (code === "23505") {
      return { ok: false, status: 409, message: COMPANY_NAME_TAKEN_MESSAGE };
    }
    console.error("renameCompanyDisplayName:", err);
    return { ok: false, status: 500, message: "Could not update company name" };
  }
}

export type EnsureCompanyResult =
  | { ok: true; company: CompanyRow; created: boolean }
  | { ok: false; status: number; message: string };

/**
 * Returns an existing company (case-insensitive name match) or inserts a new row.
 * `created` is true when a new row was inserted.
 */
export async function ensureCompanyByName(rawName: string): Promise<EnsureCompanyResult> {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { ok: false, status: 400, message: "Company name is required" };
  }
  const norm = trimmed.toLowerCase();
  try {
    const [existing] = await db
      .select()
      .from(companies)
      .where(sql`lower(trim(${companies.name})) = ${norm}`)
      .limit(1);
    if (existing) {
      return { ok: true, company: existing, created: false };
    }
    const inserted = await createCompany(trimmed);
    if (!inserted.ok) {
      // Concurrent signup with the same new name: treat as join existing company
      if (inserted.status === 409) {
        const [race] = await db
          .select()
          .from(companies)
          .where(sql`lower(trim(${companies.name})) = ${norm}`)
          .limit(1);
        if (race) {
          return { ok: true, company: race, created: false };
        }
      }
      return inserted;
    }
    return { ok: true, company: inserted.company, created: true };
  } catch (err) {
    console.error("ensureCompanyByName:", err);
    return { ok: false, status: 500, message: "Could not resolve company" };
  }
}
