import { and, eq, isNull } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db, pool } from "../../database/db.js";
import {
  contact,
  contactImportBatch,
  contactImportRow,
  type ContactImportCounts,
  type ContactImportRowRow,
  type ContactInsert,
  type ContactRow,
} from "../../schema/contact.schema.js";
import { canonicalUsPhoneKey10, parseUsPhoneToE164 } from "../../utils/usPhone.js";
import { invalidateContactDirectoryCache } from "../cache/listReadCache.js";
import { syncContactRowToGhl } from "../ghl/ghlContactSync.service.js";
import { resolveOrganizationIdForUserId } from "../org/orgResolution.service.js";
import { syncOrganizationContactLabels } from "./organizationContactLabels.service.js";
import {
  buildContactFullName,
  getUserDisplayNameById,
  updateContactFieldsForViewer,
} from "./contact.service.js";

export type ContactImportFileType = "csv" | "excel";
export type ContactImportDuplicateMode = "skip" | "update";

export type ContactImportField =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "note"
  | "tags"
  | "lists";

export type ContactImportMapping = Partial<Record<ContactImportField, string | null>>;

export type ContactImportPreviewRow = {
  id: string;
  rowIndex: number;
  raw: Record<string, string>;
  normalized: NormalizedImportContact | null;
  errors: string[];
  status: "valid" | "invalid" | "duplicate" | "imported" | "skipped" | "updated";
  duplicateContactId: string | null;
  duplicateMatch: "email" | "phone" | null;
};

export type ContactImportParseResult = {
  batchId: string;
  headers: string[];
  suggestedMapping: ContactImportMapping;
  sampleRows: Record<string, string>[];
  totalRows: number;
};

export type ContactImportPreviewResult = {
  batchId: string;
  counts: ContactImportCounts;
  rows: ContactImportPreviewRow[];
};

export type ContactImportConfirmResult = ContactImportPreviewResult & {
  importedContactIds: string[];
};

type NormalizedImportContact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  note: string;
  tags: string[];
  lists: string[];
  owners: string[];
  mappedFields: ContactImportField[];
};

const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_ROWS = 50_000;
const PREVIEW_LIMIT = 100;
const WRITE_CHUNK = 500;

const FIELD_LABELS: Record<ContactImportField, string> = {
  firstName: "First Name",
  lastName: "Last Name",
  fullName: "Full Name",
  email: "Email",
  phone: "Phone",
  note: "Note",
  tags: "Tags",
  lists: "Lists",
};

const FIELD_ALIASES: Record<ContactImportField, string[]> = {
  firstName: ["first name", "firstname", "first", "fname", "given name"],
  lastName: ["last name", "lastname", "last", "lname", "surname", "family name"],
  fullName: ["full name", "fullname", "name", "contact name"],
  email: ["email", "email address", "e-mail", "mail"],
  phone: ["phone", "mobile", "mobile number", "phone number", "cell", "cell phone"],
  note: ["note", "notes", "comments", "comment"],
  tags: ["tags", "contact tags", "tag"],
  lists: ["lists", "list"],
};

function cleanHeader(value: unknown, fallbackIndex: number): string {
  const s = String(value ?? "").trim();
  return s || `Column ${fallbackIndex + 1}`;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const base = cleanHeader(header, index);
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(buffer: Buffer): string[][] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let line = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        line += ch + text[i + 1];
        i += 1;
      } else {
        inQuotes = !inQuotes;
        line += ch;
      }
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      rows.push(parseCsvLine(line));
      line = "";
    } else {
      line += ch;
    }
  }
  if (line || text.endsWith(",")) rows.push(parseCsvLine(line));
  return rows;
}

function parseWorkbook(buffer: Buffer): string[][] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false,
  }).map((row) => row.map(cellToString));
}

function rowsToObjects(matrix: string[][]): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const firstNonEmpty = matrix.findIndex((row) =>
    row.some((cell) => String(cell ?? "").trim()),
  );
  if (firstNonEmpty < 0) return { headers: [], rows: [] };
  const headers = dedupeHeaders(matrix[firstNonEmpty]!.map(cleanHeader));
  const dataRows = matrix
    .slice(firstNonEmpty + 1)
    .filter((row) => row.some((cell) => String(cell ?? "").trim()));
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `This file has ${dataRows.length.toLocaleString()} rows. An import can include up to ${MAX_IMPORT_ROWS.toLocaleString()} rows.`,
    );
  }
  const rows = dataRows
    .map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((header, index) => {
        obj[header] = cellToString(row[index]);
      });
      return obj;
    });
  return { headers, rows };
}

function inferFileType(fileName: string, mimeType: string): ContactImportFileType {
  const lower = fileName.toLowerCase();
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel")
  ) {
    return "excel";
  }
  return "csv";
}

function suggestMapping(headers: string[]): ContactImportMapping {
  const normalizedHeaders = headers.map((header) => ({
    header,
    key: normalizeKey(header),
  }));
  const mapping: ContactImportMapping = {};
  const used = new Set<string>();
  for (const field of Object.keys(FIELD_LABELS) as ContactImportField[]) {
    const aliases = FIELD_ALIASES[field].map(normalizeKey);
    const exact = normalizedHeaders.find(
      (h) => !used.has(h.header) && aliases.includes(h.key),
    );
    const loose =
      exact ??
      normalizedHeaders.find(
        (h) =>
          !used.has(h.header) &&
          aliases.some((alias) => h.key.includes(alias) || alias.includes(h.key)),
      );
    if (loose) {
      mapping[field] = loose.header;
      used.add(loose.header);
    }
  }
  if (!mapping.firstName && !mapping.lastName && mapping.fullName) {
    mapping.firstName = null;
    mapping.lastName = null;
  }
  return mapping;
}

function mappedValue(
  raw: Record<string, string>,
  mapping: ContactImportMapping,
  field: ContactImportField,
): string {
  const header = mapping[field];
  return header ? String(raw[header] ?? "").trim() : "";
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1] ?? "",
  };
}

function splitMultiValue(raw: string): string[] {
  return raw
    .split(/[;,|]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeMappedRow(
  raw: Record<string, string>,
  mapping: ContactImportMapping,
  defaultOwner: string,
): { normalized: NormalizedImportContact; errors: string[] } {
  const mappedFields = (Object.keys(mapping) as ContactImportField[]).filter(
    (field) => Boolean(mapping[field]),
  );
  const fullName = mappedValue(raw, mapping, "fullName");
  const split = splitName(fullName);
  const firstName = mappedValue(raw, mapping, "firstName") || split.firstName;
  const lastName = mappedValue(raw, mapping, "lastName") || split.lastName;
  const email = mappedValue(raw, mapping, "email").toLowerCase();
  const phoneRaw = mappedValue(raw, mapping, "phone");
  const phone = phoneRaw ? parseUsPhoneToE164(phoneRaw) : "";
  const errors: string[] = [];

  if (!firstName) errors.push("First name is required.");
  if (!email) {
    errors.push("Email is required.");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Email format is invalid.");
  }
  if (phoneRaw && !phone) errors.push("Phone must be a valid 10-digit U.S. number.");

  const normalized: NormalizedImportContact = {
    firstName,
    lastName,
    email,
    phone: phone || phoneRaw,
    note: mappedValue(raw, mapping, "note"),
    tags: splitMultiValue(mappedValue(raw, mapping, "tags")),
    lists: splitMultiValue(mappedValue(raw, mapping, "lists")),
    owners: defaultOwner ? [defaultOwner] : [],
    mappedFields,
  };

  return { normalized, errors };
}

type StagedImportRow = {
  id: string;
  normalized: NormalizedImportContact | null;
  errors: string[];
  status: string;
  duplicateContactId: string | null;
  duplicateMatch: string | null;
};

async function loadDuplicateIndex(
  userId: string,
  organizationId: string | null,
): Promise<{ byEmail: Map<string, string>; byPhone: Map<string, string> }> {
  const scope = organizationId
    ? eq(contact.organizationId, organizationId)
    : and(isNull(contact.organizationId), eq(contact.createdBy, userId));
  const matches = await db
    .select({
      id: contact.id,
      email: contact.email,
      phone: contact.phone,
    })
    .from(contact)
    .where(scope);
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  for (const row of matches) {
    const email = String(row.email ?? "").trim().toLowerCase();
    const phone = canonicalUsPhoneKey10(String(row.phone ?? ""));
    if (email && !byEmail.has(email)) byEmail.set(email, row.id);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, row.id);
  }
  return { byEmail, byPhone };
}

async function insertParsedRows(
  batchId: string,
  rows: Record<string, string>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const slice = rows.slice(i, i + WRITE_CHUNK);
    await db.insert(contactImportRow).values(
      slice.map((row, offset) => ({
        batchId,
        rowIndex: i + offset + 2,
        raw: row,
        normalized: null,
        errors: [],
        status: "parsed",
      })),
    );
  }
}

async function writeStagedRows(rows: StagedImportRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const slice = rows.slice(i, i + WRITE_CHUNK);
    await pool.query(
      `UPDATE contact_import_row AS r
       SET normalized = v.normalized::jsonb,
           errors = v.errors::jsonb,
           status = v.status,
           duplicate_contact_id = v.duplicate_contact_id,
           duplicate_match = NULLIF(v.duplicate_match, '')
       FROM unnest(
         $1::uuid[],
         $2::text[],
         $3::text[],
         $4::text[],
         $5::uuid[],
         $6::text[]
       ) AS v(id, normalized, errors, status, duplicate_contact_id, duplicate_match)
       WHERE r.id = v.id`,
      [
        slice.map((row) => row.id),
        slice.map((row) => JSON.stringify(row.normalized)),
        slice.map((row) => JSON.stringify(row.errors)),
        slice.map((row) => row.status),
        slice.map((row) => row.duplicateContactId),
        slice.map((row) => row.duplicateMatch ?? ""),
      ],
    );
  }
}

function queueImportedContactsForGhl(rows: ContactRow[]): void {
  if (rows.length === 0) return;
  const pending = rows.slice();
  const run = async () => {
    while (pending.length > 0) {
      const row = pending.shift();
      if (!row) return;
      try {
        await syncContactRowToGhl(row);
      } catch (err) {
        console.error("import contact GHL sync:", err);
      }
    }
  };
  const workers = Math.min(4, pending.length);
  for (let i = 0; i < workers; i += 1) void run();
}

async function insertNewImportContacts(params: {
  userId: string;
  organizationId: string | null;
  importSource: "excel" | "csv";
  rows: Array<{ rowId: string; normalized: NormalizedImportContact }>;
}): Promise<{ importedIds: string[]; failed: number }> {
  if (params.rows.length === 0) return { importedIds: [], failed: 0 };
  const organizationId =
    params.organizationId ??
    (await resolveOrganizationIdForUserId(params.userId));
  const emails = [
    ...new Set(
      params.rows
        .map((row) => row.normalized.email.trim().toLowerCase())
        .filter((email) => email.includes("@")),
    ),
  ];
  const portalEmails = new Set<string>();
  if (emails.length > 0) {
    const found = await pool.query<{ email: string | null }>(
      `SELECT email FROM users WHERE lower(trim(email)) = ANY($1::text[])`,
      [emails],
    );
    for (const row of found.rows) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (email) portalEmails.add(email);
    }
  }

  const importedIds: string[] = [];
  const createdRows: ContactRow[] = [];
  let failed = 0;
  const tags = new Set<string>();
  const lists = new Set<string>();

  for (let i = 0; i < params.rows.length; i += WRITE_CHUNK) {
    const slice = params.rows.slice(i, i + WRITE_CHUNK);
    const values: ContactInsert[] = slice.map((row) => ({
      firstName: row.normalized.firstName,
      lastName: row.normalized.lastName,
      fullName: buildContactFullName(
        row.normalized.firstName,
        row.normalized.lastName,
      ),
      email: row.normalized.email,
      phone: row.normalized.phone,
      note: row.normalized.note,
      tags: row.normalized.tags,
      lists: row.normalized.lists,
      owners: row.normalized.owners,
      status: "active",
      createdBy: params.userId,
      organizationId: organizationId ?? null,
      isPortalUser: portalEmails.has(row.normalized.email.trim().toLowerCase()),
      relationship506b: "NO",
      importSource: params.importSource,
    }));
    try {
      const inserted = await db.insert(contact).values(values).returning();
      const byEmail = new Map(
        inserted.map((row) => [row.email.trim().toLowerCase(), row]),
      );
      const importRowIds: string[] = [];
      const contactIds: string[] = [];
      for (const source of slice) {
        const row = byEmail.get(source.normalized.email.trim().toLowerCase());
        if (!row) continue;
        importedIds.push(row.id);
        createdRows.push(row);
        importRowIds.push(source.rowId);
        contactIds.push(row.id);
        for (const tag of source.normalized.tags) tags.add(tag);
        for (const list of source.normalized.lists) lists.add(list);
      }
      if (importRowIds.length > 0) {
        await pool.query(
          `UPDATE contact_import_row AS r
           SET status = 'imported',
               import_contact_id = v.contact_id,
               errors = '[]'::jsonb
           FROM unnest($1::uuid[], $2::uuid[]) AS v(id, contact_id)
           WHERE r.id = v.id`,
          [importRowIds, contactIds],
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not import this row.";
      failed += slice.length;
      await pool.query(
        `UPDATE contact_import_row AS r
         SET status = 'invalid',
             errors = $2::jsonb
         FROM unnest($1::uuid[]) AS v(id)
         WHERE r.id = v.id`,
        [slice.map((row) => row.rowId), JSON.stringify([message])],
      );
    }
  }

  await syncOrganizationContactLabels({
    organizationId: organizationId ?? null,
    tags: [...tags],
    lists: [...lists],
  });
  queueImportedContactsForGhl(createdRows);
  return { importedIds, failed };
}

function emptyCounts(totalRows: number): ContactImportCounts {
  return {
    totalRows,
    newRows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    importedRows: 0,
    skippedRows: 0,
    updatedRows: 0,
  };
}

function rowToPreview(row: ContactImportRowRow): ContactImportPreviewRow {
  return {
    id: row.id,
    rowIndex: row.rowIndex,
    raw: row.raw ?? {},
    normalized: (row.normalized as NormalizedImportContact | null) ?? null,
    errors: row.errors ?? [],
    status: row.status as ContactImportPreviewRow["status"],
    duplicateContactId: row.duplicateContactId ?? null,
    duplicateMatch: (row.duplicateMatch as "email" | "phone" | null) ?? null,
  };
}

async function loadOwnedBatch(batchId: string, userId: string) {
  const [batch] = await db
    .select()
    .from(contactImportBatch)
    .where(and(eq(contactImportBatch.id, batchId), eq(contactImportBatch.createdBy, userId)))
    .limit(1);
  return batch ?? null;
}

export async function parseContactImportFile(params: {
  userId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<ContactImportParseResult> {
  if (!params.buffer.length) throw new Error("Upload a CSV or Excel file.");
  if (params.buffer.length > MAX_IMPORT_BYTES) {
    throw new Error("Import file is too large. Use a file under 32 MB.");
  }
  const fileType = inferFileType(params.fileName, params.mimeType);
  const matrix =
    fileType === "excel" ? parseWorkbook(params.buffer) : parseCsv(params.buffer);
  const { headers, rows } = rowsToObjects(matrix);
  if (headers.length === 0) throw new Error("No header row found in the file.");
  if (rows.length === 0) throw new Error("No contact rows found in the file.");

  const organizationId = await resolveOrganizationIdForUserId(params.userId);
  const suggestedMapping = suggestMapping(headers);
  const [batch] = await db
    .insert(contactImportBatch)
    .values({
      organizationId: organizationId ?? null,
      createdBy: params.userId,
      fileName: params.fileName,
      fileType,
      headers,
      mapping: suggestedMapping,
      counts: emptyCounts(rows.length),
    })
    .returning();
  if (!batch) throw new Error("Could not create import batch.");

  await insertParsedRows(batch.id, rows);

  return {
    batchId: batch.id,
    headers,
    suggestedMapping,
    sampleRows: rows.slice(0, 5),
    totalRows: rows.length,
  };
}

export async function previewContactImport(params: {
  userId: string;
  batchId: string;
  mapping: ContactImportMapping;
}): Promise<ContactImportPreviewResult> {
  const batch = await loadOwnedBatch(params.batchId, params.userId);
  if (!batch) throw new Error("Import batch not found.");

  const rows = await db
    .select()
    .from(contactImportRow)
    .where(eq(contactImportRow.batchId, batch.id));
  const defaultOwner = (await getUserDisplayNameById(params.userId)).trim();
  const counts = emptyCounts(rows.length);
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const existing = await loadDuplicateIndex(
    params.userId,
    batch.organizationId ?? null,
  );
  const staged: StagedImportRow[] = [];

  for (const row of rows) {
    const { normalized, errors } = normalizeMappedRow(
      row.raw ?? {},
      params.mapping,
      defaultOwner,
    );
    let status: ContactImportPreviewRow["status"] = "valid";
    let duplicateContactId: string | null = null;
    let duplicateMatch: "email" | "phone" | null = null;
    const rowErrors = [...errors];

    if (errors.length === 0) {
      const emailKey = normalized.email.trim().toLowerCase();
      const phoneKey = canonicalUsPhoneKey10(normalized.phone);
      if (emailKey && seenEmails.has(emailKey)) {
        rowErrors.push("Duplicate email within this import file.");
      }
      if (phoneKey && seenPhones.has(phoneKey)) {
        rowErrors.push("Duplicate phone within this import file.");
      }
      seenEmails.add(emailKey);
      if (phoneKey) seenPhones.add(phoneKey);
    }

    if (rowErrors.length > 0) {
      status = "invalid";
      counts.invalidRows += 1;
    } else {
      const emailKey = normalized.email.trim().toLowerCase();
      const phoneKey = canonicalUsPhoneKey10(normalized.phone);
      const emailHit = emailKey ? existing.byEmail.get(emailKey) : undefined;
      const phoneHit = phoneKey ? existing.byPhone.get(phoneKey) : undefined;
      if (emailHit || phoneHit) {
        status = "duplicate";
        duplicateContactId = emailHit ?? phoneHit ?? null;
        duplicateMatch = emailHit ? "email" : "phone";
        counts.duplicateRows += 1;
      } else {
        counts.newRows += 1;
      }
    }

    staged.push({
      id: row.id,
      normalized,
      errors: rowErrors,
      status,
      duplicateContactId,
      duplicateMatch,
    });
  }

  await writeStagedRows(staged);

  await db
    .update(contactImportBatch)
    .set({
      mapping: params.mapping,
      counts,
      status: "previewed",
      updatedAt: new Date(),
    })
    .where(eq(contactImportBatch.id, batch.id));

  const previewRows = await db
    .select()
    .from(contactImportRow)
    .where(eq(contactImportRow.batchId, batch.id))
    .limit(PREVIEW_LIMIT);

  return {
    batchId: batch.id,
    counts,
    rows: previewRows.map(rowToPreview),
  };
}

async function loadContactById(contactId: string): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return row ?? null;
}

function mergeForUpdate(
  existing: ContactRow,
  normalized: NormalizedImportContact,
) {
  const mapped = new Set(normalized.mappedFields);
  return {
    firstName: mapped.has("firstName") || mapped.has("fullName") ? normalized.firstName : existing.firstName,
    lastName: mapped.has("lastName") || mapped.has("fullName") ? normalized.lastName : existing.lastName,
    email: mapped.has("email") ? normalized.email : existing.email,
    phone: mapped.has("phone") ? normalized.phone : existing.phone,
    note: mapped.has("note") ? normalized.note : existing.note,
    tags: mapped.has("tags") ? normalized.tags : existing.tags ?? [],
    lists: mapped.has("lists") ? normalized.lists : existing.lists ?? [],
    owners: normalized.owners,
    lastEditReason: "Updated from contact import",
  };
}

export async function confirmContactImport(params: {
  userId: string;
  batchId: string;
  duplicateMode: ContactImportDuplicateMode;
}): Promise<ContactImportConfirmResult> {
  const batch = await loadOwnedBatch(params.batchId, params.userId);
  if (!batch) throw new Error("Import batch not found.");

  const rows = await db
    .select()
    .from(contactImportRow)
    .where(eq(contactImportRow.batchId, batch.id));
  const counts = emptyCounts(rows.length);
  const importedContactIds: string[] = [];
  const pendingNew: Array<{
    rowId: string;
    normalized: NormalizedImportContact;
  }> = [];

  for (const row of rows) {
    const normalized = row.normalized as NormalizedImportContact | null;
    if (row.status === "invalid" || !normalized) {
      counts.invalidRows += 1;
      continue;
    }

    if (row.status === "duplicate") {
      counts.duplicateRows += 1;
      if (params.duplicateMode !== "update" || !row.duplicateContactId) {
        counts.skippedRows += 1;
        await db
          .update(contactImportRow)
          .set({ status: "skipped" })
          .where(eq(contactImportRow.id, row.id));
        continue;
      }
      const existing = await loadContactById(row.duplicateContactId);
      if (!existing) {
        counts.skippedRows += 1;
        await db
          .update(contactImportRow)
          .set({ status: "skipped", errors: ["Duplicate contact no longer exists."] })
          .where(eq(contactImportRow.id, row.id));
        continue;
      }
      try {
        const updated = await updateContactFieldsForViewer(
          params.userId,
          existing.id,
          mergeForUpdate(existing, normalized),
        );
        if (!updated) {
          counts.skippedRows += 1;
          await db
            .update(contactImportRow)
            .set({ status: "skipped", errors: ["You do not have access to update this contact."] })
            .where(eq(contactImportRow.id, row.id));
          continue;
        }
        counts.updatedRows += 1;
        importedContactIds.push(updated.id);
        await db
          .update(contactImportRow)
          .set({ status: "updated", importContactId: updated.id })
          .where(eq(contactImportRow.id, row.id));
      } catch (err) {
        counts.invalidRows += 1;
        const message =
          err instanceof Error ? err.message : "Could not update this duplicate.";
        await db
          .update(contactImportRow)
          .set({ status: "invalid", errors: [message] })
          .where(eq(contactImportRow.id, row.id));
      }
      continue;
    }

    pendingNew.push({ rowId: row.id, normalized });
  }

  const created = await insertNewImportContacts({
    userId: params.userId,
    organizationId: batch.organizationId ?? null,
    importSource: batch.fileType === "excel" ? "excel" : "csv",
    rows: pendingNew,
  });
  counts.newRows += pendingNew.length;
  counts.importedRows += created.importedIds.length;
  counts.invalidRows += created.failed;
  importedContactIds.push(...created.importedIds);
  if (created.importedIds.length > 0 || counts.updatedRows > 0) {
    invalidateContactDirectoryCache();
  }

  await db
    .update(contactImportBatch)
    .set({
      duplicateMode: params.duplicateMode,
      counts,
      status: "imported",
      updatedAt: new Date(),
    })
    .where(eq(contactImportBatch.id, batch.id));

  const previewRows = await db
    .select()
    .from(contactImportRow)
    .where(eq(contactImportRow.batchId, batch.id))
    .limit(PREVIEW_LIMIT);

  return {
    batchId: batch.id,
    counts,
    importedContactIds,
    rows: previewRows.map(rowToPreview),
  };
}
