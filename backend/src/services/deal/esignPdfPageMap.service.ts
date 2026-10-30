import { createHash, type Hash } from "node:crypto";
import {
  PDFArray,
  PDFDocument,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";
import type { SignFlowField } from "../esign/signflow.service.js";

function hashPdfObject(hash: Hash, value: PDFObject | undefined): void {
  if (!value) return;
  if (value instanceof PDFArray) {
    hash.update("[");
    for (let i = 0; i < value.size(); i += 1) {
      hashPdfObject(hash, value.get(i));
    }
    hash.update("]");
    return;
  }
  if (value instanceof PDFNumber) {
    hash.update(String(value.asNumber()));
    return;
  }
  const bytes = pdfStreamBytes(value);
  if (bytes) hash.update(bytes);
}

function pdfStreamBytes(value: PDFObject): Uint8Array | null {
  if (value instanceof PDFRawStream) return value.getContents();
  const maybe = value as unknown as { getContents?: () => Uint8Array };
  if (typeof maybe.getContents !== "function") return null;
  return maybe.getContents();
}

/**
 * Stable fingerprint for a single PDF page.
 * Hashes the page content stream and box, not a re-saved PDF. pdf-lib stamps
 * ModDate on every save, so hashing the wrapper file changes every second and
 * falls back to page numbers when questionnaire pages are inserted.
 */
export async function computePdfPageFingerprints(buffer: Buffer): Promise<string[]> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const hashes: string[] = [];

  for (const page of doc.getPages()) {
    const hash = createHash("sha256");
    const { width, height } = page.getSize();
    hash.update(`${width}x${height}@${page.getRotation().angle}`);
    const contents = page.node.Contents();
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const item = contents.get(i);
        const stream =
          item instanceof PDFRef ? doc.context.lookup(item) : item;
        hashPdfObject(hash, stream);
      }
    } else if (contents instanceof PDFRef) {
      hashPdfObject(hash, doc.context.lookup(contents));
    } else {
      hashPdfObject(hash, contents);
    }
    hashes.push(hash.digest("hex").slice(0, 16));
  }

  return hashes;
}

/**
 * Maps 1-based template page numbers to 1-based signing PDF page numbers by
 * matching page fingerprints in order (handles prepended answer pages).
 */
export function buildTemplatePageToSigningPageMap(
  referenceHashes: string[],
  signingHashes: string[],
): Map<number, number> {
  const map = new Map<number, number>();
  let signingCursor = 0;

  for (let t = 0; t < referenceHashes.length; t++) {
    const refHash = referenceHashes[t];
    let matched = -1;

    for (let s = signingCursor; s < signingHashes.length; s++) {
      if (signingHashes[s] === refHash) {
        matched = s;
        break;
      }
    }

    if (matched >= 0) {
      map.set(t + 1, matched + 1);
      signingCursor = matched + 1;
    }
  }

  // Pages whose bytes did not match still follow the prepended-page shift
  // discovered from the pages that did match. They are not left on the raw
  // template page number (that number points at a questionnaire answer page).
  let prefix = 0;
  for (let t = 0; t < referenceHashes.length; t += 1) {
    const signingPage = map.get(t + 1);
    if (signingPage == null) continue;
    prefix = signingPage - (t + 1);
    break;
  }
  if (prefix > 0) {
    for (let t = 0; t < referenceHashes.length; t += 1) {
      if (map.has(t + 1)) continue;
      const shifted = t + 1 + prefix;
      if (shifted <= signingHashes.length) map.set(t + 1, shifted);
    }
  }

  return map;
}

/**
 * Template page identity comes from pageHash first. Page numbers alone shift when
 * questionnaire answer pages are prepended, so hash is the stable placement key.
 */
export function resolveTemplatePageFromField(
  field: SignFlowField,
  referenceHashes: string[],
): number {
  const numbered = Math.max(1, Math.floor(field.templatePage ?? field.page));
  const pageHash = field.pageHash?.trim();
  if (!pageHash) return numbered;
  // The page number already points at this hash. Keep it so an earlier
  // duplicate page does not steal the field.
  if (referenceHashes[numbered - 1] === pageHash) return numbered;
  const byHash = referenceHashes.indexOf(pageHash);
  if (byHash >= 0) return byHash + 1;
  return numbered;
}

export function resolveSigningPageForField(
  field: SignFlowField,
  pageMap: Map<number, number>,
  signingHashes: string[],
  referenceHashes: string[],
): number {
  const templatePage = resolveTemplatePageFromField(field, referenceHashes);
  // pageMap is built by matching page hashes in order. A raw page number is
  // only used when this template page was not shifted by inserted pages.
  const mapped = pageMap.get(templatePage);
  if (mapped != null) return mapped;

  const pageHash =
    field.pageHash?.trim() || referenceHashes[templatePage - 1] || "";
  if (pageHash) {
    const byHash = signingHashes.indexOf(pageHash);
    if (byHash >= 0) return byHash + 1;
  }

  return Math.max(1, Math.floor(field.templatePage ?? field.page));
}

/**
 * Re-maps sponsor-placed field pages from the template PDF to the investor
 * signing PDF. x/y/width/height and profile scope are unchanged.
 * Placement follows pageHash when present so questionnaire page inserts do not
 * slide fields onto the wrong page.
 */
export async function remapSignFlowFieldsToSigningPdf(
  fields: SignFlowField[],
  referencePdf: Buffer,
  signingPdf: Buffer,
): Promise<SignFlowField[]> {
  if (!fields.length) return fields;

  const [referenceHashes, signingHashes] = await Promise.all([
    computePdfPageFingerprints(referencePdf),
    computePdfPageFingerprints(signingPdf),
  ]);
  const pageMap = buildTemplatePageToSigningPageMap(
    referenceHashes,
    signingHashes,
  );
  const signingPageCount = Math.max(1, signingHashes.length);

  return fields.map((field) => {
    const templatePage = resolveTemplatePageFromField(field, referenceHashes);
    const contentHash = referenceHashes[templatePage - 1];
    const storedHash = field.pageHash?.trim();
    const pageHash =
      storedHash &&
      (storedHash === contentHash || referenceHashes.includes(storedHash))
        ? storedHash
        : contentHash;
    const page = Math.min(
      signingPageCount,
      Math.max(
        1,
        resolveSigningPageForField(
          field,
          pageMap,
          signingHashes,
          referenceHashes,
        ),
      ),
    );
    return {
      ...field,
      page,
      templatePage,
      pageHash: pageHash || undefined,
    };
  });
}

function signFlowFieldCoordPercent(value: number | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function signFlowFieldDedupeRank(field: SignFlowField): number {
  const type = String(field.type ?? "")
    .trim()
    .toLowerCase();
  // Prefer catalog/sponsor-added and required fields when resolving true duplicates.
  const catalogBonus = String(field.dataKey ?? "").trim() ? -1 : 0;
  const requiredBonus = field.required === false ? 1 : 0;
  if (type === "signature") return 0 + catalogBonus + requiredBonus;
  if (type === "text") return 1 + catalogBonus + requiredBonus;
  if (type === "date_signed" || type === "date") return 4 + catalogBonus + requiredBonus;
  return 2 + catalogBonus + requiredBonus;
}

function signFlowFieldCenter(field: SignFlowField): { x: number; y: number } {
  return {
    x:
      signFlowFieldCoordPercent(field.x, 0) +
      signFlowFieldCoordPercent(field.width, 1) / 2,
    y:
      signFlowFieldCoordPercent(field.y, 0) +
      signFlowFieldCoordPercent(field.height, 1) / 2,
  };
}

function isSigningStyleFieldType(type: string): boolean {
  const t = type.trim().toLowerCase();
  return (
    t === "signature" ||
    t === "initials" ||
    t === "initial" ||
    t === "date_signed" ||
    t === "date" ||
    t.includes("sign") ||
    t.includes("initial")
  );
}

function signFlowFieldLabelKey(field: SignFlowField): string {
  return String(field.label ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function signFlowFieldsSamePlacement(a: SignFlowField, b: SignFlowField): boolean {
  const pageA = Math.max(1, Math.floor(a.page));
  const pageB = Math.max(1, Math.floor(b.page));
  if (pageA !== pageB) return false;
  if (
    String(a.recipientId ?? "").trim() !== String(b.recipientId ?? "").trim()
  ) {
    return false;
  }

  const labelA = signFlowFieldLabelKey(a);
  const labelB = signFlowFieldLabelKey(b);
  const dataKeyA = String(a.dataKey ?? "").trim();
  const dataKeyB = String(b.dataKey ?? "").trim();
  const sameCatalogOrLabel =
    (Boolean(dataKeyA) && dataKeyA === dataKeyB) ||
    (Boolean(labelA) && labelA === labelB);

  const typeA = String(a.type ?? "")
    .trim()
    .toLowerCase();
  const typeB = String(b.type ?? "")
    .trim()
    .toLowerCase();

  const centerA = signFlowFieldCenter(a);
  const centerB = signFlowFieldCenter(b);
  const centersClose =
    Math.abs(centerA.x - centerB.x) <= 2 &&
    Math.abs(centerA.y - centerB.y) <= 2;

  const ax = signFlowFieldCoordPercent(a.x, 0);
  const ay = signFlowFieldCoordPercent(a.y, 0);
  const aw = Math.max(0.5, signFlowFieldCoordPercent(a.width, 1));
  const ah = Math.max(0.5, signFlowFieldCoordPercent(a.height, 1));
  const bx = signFlowFieldCoordPercent(b.x, 0);
  const by = signFlowFieldCoordPercent(b.y, 0);
  const bw = Math.max(0.5, signFlowFieldCoordPercent(b.width, 1));
  const bh = Math.max(0.5, signFlowFieldCoordPercent(b.height, 1));

  const overlapX = ax < bx + bw && ax + aw > bx;
  const overlapY = ay < by + bh && ay + ah > by;
  const boxesOverlap = overlapX && overlapY;

  if (!centersClose && !boxesOverlap) return false;

  // Text/date data fields with different labels are distinct — never collapse
  // sponsor-added Choose-field entries into nearby auto-placed fields.
  if (!isSigningStyleFieldType(typeA) || !isSigningStyleFieldType(typeB)) {
    return sameCatalogOrLabel;
  }

  // Signature/date row: same label, or same signing type stacked on itself.
  if (sameCatalogOrLabel) return true;

  const types = new Set([typeA, typeB]);
  // Signature + date sit on the same row — never treat as duplicate placements.
  if (types.has("signature") && (types.has("date_signed") || types.has("date"))) {
    return false;
  }

  return typeA === typeB;
}

function signFlowFieldsOverlap(a: SignFlowField, b: SignFlowField): boolean {
  return signFlowFieldsSamePlacement(a, b);
}

/** Drop duplicate/overlapping SignFlow fields (template + preset questionnaire fields). */
export function dedupeSignFlowFieldsByPlacement(
  fields: SignFlowField[],
): SignFlowField[] {
  const out: SignFlowField[] = [];
  for (const field of fields) {
    const overlapIdx = out.findIndex((existing) =>
      signFlowFieldsOverlap(existing, field),
    );
    if (overlapIdx < 0) {
      out.push(field);
      continue;
    }
    if (
      signFlowFieldDedupeRank(field) <
      signFlowFieldDedupeRank(out[overlapIdx]!)
    ) {
      out[overlapIdx] = field;
    }
  }
  return out;
}
