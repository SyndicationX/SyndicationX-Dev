import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import {
  downloadSignFlowSourcePdf,
  SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID,
  type SignFlowDocument,
} from "../esign/signflow.service.js";

export { SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID };

type AlternateSignatureField = {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  page?: number;
  recipientId?: string;
  required?: boolean;
};

type Box = {
  index: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

const NAME_STOP_WORDS = new Set([
  "manager",
  "member",
  "managing",
  "sponsor",
  "investor",
  "signature",
  "signed",
  "date",
  "title",
  "llc",
  "inc",
  "company",
  "the",
  "and",
  "for",
  "its",
]);

function fieldType(field: AlternateSignatureField): string {
  return String(field.type ?? "").trim().toLowerCase();
}

function isSignatureField(field: AlternateSignatureField): boolean {
  return fieldType(field) === "signature";
}

function isDateField(field: AlternateSignatureField): boolean {
  const type = fieldType(field);
  return type === "date" || type === "date_signed";
}

export function signatureFieldsUsePixelCoordinates(
  fields: Array<{ x?: number; y?: number; width?: number; height?: number }>,
): boolean {
  return fields.some((field) => {
    const x = Number(field.x) || 0;
    const y = Number(field.y) || 0;
    const width = Number(field.width) || 0;
    const height = Number(field.height) || 0;
    return x > 100 || y > 100 || width > 100 || height > 100;
  });
}

export function signerNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !NAME_STOP_WORDS.has(token));
}

export function isPlaceholderSignerName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "sponsor" ||
    normalized === "investor" ||
    normalized === "seller" ||
    normalized === "buyer"
  );
}

/** Higher when the printed line names this signer. */
export function signatureNameScore(nearby: string, signerName: string): number {
  const tokens = signerNameTokens(signerName);
  if (!tokens.length || !nearby.trim()) return 0;
  const words = nearby
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    const hit = words.some(
      (word) =>
        word === token ||
        (token.length >= 4 &&
          (word.startsWith(token) ||
            (token.startsWith(word) && word.length >= 4))),
    );
    if (hit) score += token.length >= 4 ? 2 : 1;
  }
  return score;
}

function toBox(field: AlternateSignatureField, index: number): Box {
  return {
    index,
    page: Math.max(1, Math.floor(Number(field.page) || 1)),
    x: Number(field.x) || 0,
    y: Number(field.y) || 0,
    width: Math.max(0, Number(field.width) || 0),
    height: Math.max(0, Number(field.height) || 0),
  };
}

function rowGap(pixelMode: boolean): number {
  return pixelMode ? 90 : 12;
}

function clusterSignatureBoxes(boxes: Box[], pixelMode: boolean): Box[][] {
  const byPage = new Map<number, Box[]>();
  for (const box of boxes) {
    const list = byPage.get(box.page) ?? [];
    list.push(box);
    byPage.set(box.page, list);
  }

  const gap = rowGap(pixelMode);
  const clusters: Box[][] = [];
  for (const list of byPage.values()) {
    list.sort((a, b) => a.y - b.y);
    let current: Box[] = [];
    for (const box of list) {
      const prev = current[current.length - 1];
      if (!prev) {
        current = [box];
        continue;
      }
      const prevBottom = prev.y + prev.height;
      if (box.y - prevBottom <= gap) current.push(box);
      else {
        clusters.push(current);
        current = [box];
      }
    }
    if (current.length) clusters.push(current);
  }
  return clusters;
}

function verticalCenter(box: Box): number {
  return box.y + box.height / 2;
}

/**
 * An "OR" signature block is several signature lines for one recipient.
 * SignFlow stamps that person's signature on every line. Keep the line whose
 * printed name matches the signer, and park the others so they stay blank.
 */
export function assignAlternateSignatureFields<T extends AlternateSignatureField>(
  fields: T[],
  params: {
    recipientId: string;
    signerName: string;
    nearbyText: string[];
  },
): { fields: T[]; changed: boolean } {
  const recipientId = params.recipientId.trim();
  const signerName = params.signerName.trim();
  if (!recipientId || isPlaceholderSignerName(signerName)) {
    return { fields, changed: false };
  }

  const owned = (field: AlternateSignatureField) => {
    const rid = String(field.recipientId ?? "").trim();
    return (
      rid === recipientId || rid === SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID
    );
  };

  const signatures = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => isSignatureField(field) && owned(field));
  if (signatures.length < 2) return { fields, changed: false };

  const pixelMode = signatureFieldsUsePixelCoordinates(
    signatures.map(({ field }) => field),
  );
  const boxes = signatures.map(({ field, index }) => toBox(field, index));
  const clusters = clusterSignatureBoxes(boxes, pixelMode);
  const nextRecipient = new Map<number, string>();

  for (const cluster of clusters) {
    if (cluster.length < 2) {
      for (const box of cluster) nextRecipient.set(box.index, recipientId);
      continue;
    }
    const scores = cluster.map((box) =>
      signatureNameScore(params.nearbyText[box.index] ?? "", signerName),
    );
    const best = Math.max(...scores);
    if (best <= 0) continue;
    const winnerCount = scores.filter((score) => score === best).length;
    if (winnerCount === cluster.length) continue;
    cluster.forEach((box, index) => {
      nextRecipient.set(
        box.index,
        scores[index] === best
          ? recipientId
          : SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID,
      );
    });
  }

  if (nextRecipient.size === 0) return { fields, changed: false };

  const signatureBoxes = boxes.map((box) => ({
    ...box,
    recipientId:
      nextRecipient.get(box.index) ??
      String(fields[box.index]?.recipientId ?? "").trim(),
  }));
  const dateLimit = pixelMode ? 40 : 6;

  const next = fields.map((field, index) => {
    if (isSignatureField(field) && nextRecipient.has(index)) {
      const assigned = nextRecipient.get(index)!;
      const required = assigned === recipientId;
      if (
        String(field.recipientId ?? "").trim() === assigned &&
        Boolean(field.required) === required
      ) {
        return field;
      }
      return { ...field, recipientId: assigned, required };
    }

    if (!isDateField(field) || !owned(field)) return field;
    const dateBox = toBox(field, index);
    let nearest: (typeof signatureBoxes)[number] | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const signature of signatureBoxes) {
      if (signature.page !== dateBox.page) continue;
      const delta = Math.abs(verticalCenter(dateBox) - verticalCenter(signature));
      if (delta <= dateLimit && delta < distance) {
        distance = delta;
        nearest = signature;
      }
    }
    if (!nearest) return field;
    const assigned = nearest.recipientId;
    const required = assigned === recipientId;
    if (
      String(field.recipientId ?? "").trim() === assigned &&
      Boolean(field.required) === required
    ) {
      return field;
    }
    return { ...field, recipientId: assigned, required };
  });

  const changed = next.some((field, index) => field !== fields[index]);
  return { fields: changed ? next : fields, changed };
}

function pythonScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../python/app/services/signature_line_text.py");
}

function runProcess(
  command: string,
  args: string[],
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

async function nearbyTextForBoxes(
  pdf: Buffer,
  boxes: Array<{ index: number; page: number; x: number; y: number; width: number; height: number }>,
): Promise<Map<number, string> | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "sx-esign-"));
  const pdfPath = path.join(dir, "source.pdf");
  try {
    await writeFile(pdfPath, pdf);
    const script = pythonScriptPath();
    const stdin = JSON.stringify({ boxes });
    const bins = [process.env.PYTHON_PATH?.trim(), "python", "py"].filter(
      (bin): bin is string => Boolean(bin),
    );
    for (const bin of bins) {
      const args = bin === "py" ? ["-3", script, pdfPath] : [script, pdfPath];
      const result = await runProcess(bin, args, stdin);
      if (result.code !== 0) continue;
      try {
        const parsed = JSON.parse(result.stdout) as Array<{
          index?: number;
          text?: string;
        }>;
        const map = new Map<number, string>();
        for (const row of parsed) {
          const index = Number(row.index);
          if (!Number.isInteger(index)) continue;
          map.set(index, String(row.text ?? ""));
        }
        return map;
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Before a signing session opens, leave this signer only the signature line
 * that prints their name when the document has alternate ("OR") signature lines.
 */
export async function limitAlternateSignatureFieldsForSigner<
  T extends AlternateSignatureField,
>(params: {
  doc: SignFlowDocument;
  fields: T[];
  recipientId: string;
  signerName: string;
}): Promise<{ fields: T[]; changed: boolean }> {
  const unchanged = { fields: params.fields, changed: false };
  if (isPlaceholderSignerName(params.signerName)) return unchanged;

  const recipientId = params.recipientId.trim();
  const candidates = params.fields.filter((field) => {
    if (!isSignatureField(field)) return false;
    const rid = String(field.recipientId ?? "").trim();
    return rid === recipientId || rid === SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID;
  });
  if (candidates.length < 2) return unchanged;

  let pdf: Buffer | null = null;
  try {
    pdf = await downloadSignFlowSourcePdf(params.doc);
  } catch (err) {
    console.warn("alternate signature pdf:", err);
    return unchanged;
  }
  if (!pdf) return unchanged;

  let pageSizes: Array<{ width: number; height: number }> = [];
  try {
    const loaded = await PDFDocument.load(pdf, { ignoreEncryption: true });
    pageSizes = loaded.getPages().map((page) => page.getSize());
  } catch (err) {
    console.warn("alternate signature pdf pages:", err);
    return unchanged;
  }

  const pixelMode = signatureFieldsUsePixelCoordinates(candidates);
  const boxes = params.fields.flatMap((field, index) => {
    if (!candidates.includes(field)) return [];
    const pageNumber = Math.max(1, Math.floor(Number(field.page) || 1));
    const size = pageSizes[pageNumber - 1];
    if (!size) return [];
    const x = Number(field.x) || 0;
    const y = Number(field.y) || 0;
    const width = Number(field.width) || 0;
    const height = Number(field.height) || 0;
    if (pixelMode) {
      return [{ index, page: pageNumber, x, y, width, height }];
    }
    return [
      {
        index,
        page: pageNumber,
        x: (x / 100) * size.width,
        y: (y / 100) * size.height,
        width: (width / 100) * size.width,
        height: (height / 100) * size.height,
      },
    ];
  });
  if (boxes.length < 2) return unchanged;

  const nearby = await nearbyTextForBoxes(pdf, boxes);
  if (!nearby) return unchanged;
  const nearbyText = params.fields.map((_, index) => nearby.get(index) ?? "");
  return assignAlternateSignatureFields(params.fields, {
    recipientId,
    signerName: params.signerName,
    nearbyText,
  });
}
