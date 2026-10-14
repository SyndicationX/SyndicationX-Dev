import { and, ilike, or, sql, type SQL } from "drizzle-orm";
import type { Request } from "express";

/** Matches `TABLE_PAGE_SIZE_OPTIONS` in the portal UI. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export type SortDirection = "asc" | "desc";

export type PageQuery = {
  page: number;
  pageSize: number;
  offset: number;
  /** Trimmed, collapsed free-text search; empty string when absent. */
  search: string;
  /** Column id requested by the table header, validated by the caller. */
  sortId: string;
  sortDir: SortDirection;
  /**
   * `false` when the client sent no `page`/`pageSize`, meaning it wants the
   * whole list. Callers must keep returning every row in that case so
   * endpoints stay usable by screens that have not moved to paged loading.
   */
  paginated: boolean;
};

export type PageEnvelope = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function positiveInt(raw: unknown): number | null {
  if (Array.isArray(raw)) return positiveInt(raw[0]);
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function firstString(raw: unknown): string {
  if (Array.isArray(raw)) return firstString(raw[0]);
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * Reads `page`, `pageSize`, `search`, `sort`, and `sortDir` off a list request.
 *
 * Pagination is opt-in: a request without `page` or `pageSize` is reported as
 * `paginated: false` so existing callers keep receiving the full list.
 */
export function parsePageQuery(
  req: Request,
  opts: { defaultSortId?: string; defaultSortDir?: SortDirection } = {},
): PageQuery {
  const rawPage = positiveInt(req.query.page);
  const rawPageSize = positiveInt(req.query.pageSize);
  const paginated = rawPage !== null || rawPageSize !== null;
  const pageSize = Math.min(rawPageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = rawPage ?? 1;
  const sortDirRaw = firstString(req.query.sortDir).toLowerCase();
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search: firstString(req.query.search).replace(/\s+/g, " "),
    sortId: firstString(req.query.sort) || (opts.defaultSortId ?? ""),
    sortDir:
      sortDirRaw === "asc" || sortDirRaw === "desc"
        ? sortDirRaw
        : (opts.defaultSortDir ?? "desc"),
    paginated,
  };
}

export function pageEnvelope(query: PageQuery, total: number): PageEnvelope {
  const pageSize = query.paginated ? query.pageSize : Math.max(total, 1);
  return {
    page: query.paginated ? query.page : 1,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function escapeLikeWildcards(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Free-text search across `columns`: every whitespace-separated term must match
 * at least one column, so "jane acme" finds Jane at Acme rather than either.
 * Returns `undefined` when `search` is empty so it can be spread into `and()`.
 */
export function searchWhere(
  columns: SQL[],
  search: string,
): SQL | undefined {
  const terms = search.split(" ").map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0 || columns.length === 0) return undefined;
  const perTerm = terms.map((term) => {
    const pattern = `%${escapeLikeWildcards(term)}%`;
    return or(...columns.map((col) => ilike(col, pattern)))!;
  });
  return and(...perTerm)!;
}

/** `coalesce(col, '')` so `ilike` still matches rows with NULL text columns. */
export function searchableColumn(column: SQL | unknown): SQL {
  return sql`coalesce(${column}, '')`;
}

/**
 * Applies the requested page to an already-materialised list.
 *
 * Use only where the rows cannot be paged in SQL (multi-source merges, heavy
 * per-row enrichment). The database is still doing the full read, so this
 * shrinks the response rather than the query.
 */
export function paginateInMemory<T>(
  rows: T[],
  query: PageQuery,
): { items: T[]; envelope: PageEnvelope } {
  const envelope = pageEnvelope(query, rows.length);
  if (!query.paginated) return { items: rows, envelope };
  return {
    items: rows.slice(query.offset, query.offset + query.pageSize),
    envelope,
  };
}

/** `lead_sponsor` and `Lead Sponsor` should both match a search for "lead sponsor". */
function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Flattens every string and number reachable from a row into one searchable
 * blob, including nested membership and organization objects.
 *
 * Rows reaching here are API payloads rather than raw table rows, so this picks
 * up values the table shows which never existed as a column.
 */
export function rowSearchHaystack(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return "";
  if (typeof value === "string") return normalizeForSearch(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((v) => rowSearchHaystack(v, depth + 1)).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((v) => rowSearchHaystack(v, depth + 1))
      .join(" ");
  }
  return "";
}

/**
 * Keeps rows matching every whitespace-separated term, mirroring
 * {@link searchWhere} so paged-in-memory tables behave like SQL-paged ones.
 *
 * `extraText` adds values the row object does not carry, such as a label the
 * caller derives separately.
 */
export function filterRowsBySearch<T>(
  rows: T[],
  search: string,
  extraText?: (row: T) => string,
): T[] {
  const terms = normalizeForSearch(search).split(" ").filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const hay = `${rowSearchHaystack(row)} ${
      extraText ? normalizeForSearch(extraText(row)) : ""
    }`;
    return terms.every((term) => hay.includes(term));
  });
}

/**
 * Stable sort by a caller-supplied value for the requested column. Rows keep
 * their incoming order when the column is unknown, preserving whatever default
 * ordering the query applied.
 */
export function sortRowsBy<T>(
  rows: T[],
  sortId: string,
  direction: SortDirection,
  valueFor: (row: T, sortId: string) => string | number | null | undefined,
): T[] {
  if (!sortId) return rows;
  const probe = rows.length > 0 ? valueFor(rows[0]!, sortId) : undefined;
  if (probe === undefined) return rows;
  const factor = direction === "asc" ? 1 : -1;
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const va = valueFor(a.row, sortId) ?? "";
      const vb = valueFor(b.row, sortId) ?? "";
      if (va === vb) return a.index - b.index;
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * factor;
      }
      return String(va).localeCompare(String(vb), undefined, {
        sensitivity: "base",
        numeric: true,
      }) * factor;
    })
    .map((entry) => entry.row);
}
