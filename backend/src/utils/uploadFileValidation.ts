import * as path from "node:path";

export const ALLOWED_IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "ico",
]);

export const ALLOWED_DEAL_IMAGE_EXT = ALLOWED_IMAGE_EXT;

export const ALLOWED_ESIGN_EXT = new Set(["pdf"]);

export const BLOCKED_UPLOAD_EXT = new Set([
  "sql",
  "env",
  "pem",
  "key",
  "sh",
  "bat",
  "cmd",
  "exe",
  "php",
  "js",
  "mjs",
  "cjs",
  "ts",
  "html",
  "htm",
]);

export type UploadFileLike = {
  originalname?: string;
  mimetype?: string;
  buffer?: Buffer;
};

function extFromMimetype(m: string): string {
  const m2 = m.toLowerCase();
  if (m2 === "image/png") return "png";
  if (m2 === "image/jpeg" || m2 === "image/jpg") return "jpg";
  if (m2 === "image/webp") return "webp";
  if (m2 === "image/gif") return "gif";
  if (m2 === "image/svg+xml") return "svg";
  if (
    m2 === "image/x-icon" ||
    m2 === "image/vnd.microsoft.icon" ||
    m2 === "image/ico"
  ) {
    return "ico";
  }
  if (m2 === "application/pdf") return "pdf";
  return "";
}

function extFromOriginalFilename(originalname: string): string {
  const b = path.extname(originalname).toLowerCase().replace(/^\./, "");
  if (b === "jpeg") return "jpg";
  return b;
}

export function resolveUploadExtension(file: UploadFileLike): string {
  const fromM = extFromMimetype(String(file.mimetype || ""));
  if (fromM) return fromM;
  return extFromOriginalFilename(String(file.originalname || ""));
}

export function isBlockedUploadExtension(ext: string): boolean {
  return BLOCKED_UPLOAD_EXT.has(ext.toLowerCase());
}

export function isAcceptableImageUpload(file: UploadFileLike): boolean {
  const ext = resolveUploadExtension(file);
  if (!ext || isBlockedUploadExtension(ext)) return false;
  if (!ALLOWED_IMAGE_EXT.has(ext)) return false;

  const m = String(file.mimetype || "").toLowerCase();
  if (m.startsWith("image/")) return true;
  if (
    m === "application/octet-stream" ||
    m === "" ||
    m === "text/plain"
  ) {
    return true;
  }
  return false;
}

export function isAcceptablePdfUpload(file: UploadFileLike): boolean {
  const ext = resolveUploadExtension(file);
  if (ext !== "pdf" || isBlockedUploadExtension(ext)) return false;
  const m = String(file.mimetype || "").toLowerCase();
  return m === "application/pdf" || m === "application/octet-stream" || m === "";
}

export function validateImageUploadFiles(
  files: UploadFileLike[],
  label = "Image",
):
  | { ok: true }
  | { ok: false; message: string } {
  for (const file of files) {
    if (!file.buffer?.length) continue;
    const ext = resolveUploadExtension(file);
    if (isBlockedUploadExtension(ext)) {
      return { ok: false, message: `${label} file type is not allowed.` };
    }
    if (!isAcceptableImageUpload(file)) {
      return {
        ok: false,
        message: `${label} must be PNG, JPEG, WebP, GIF, SVG, or ICO.`,
      };
    }
  }
  return { ok: true };
}

export function validatePdfUploadFiles(
  files: UploadFileLike[],
  label = "PDF",
):
  | { ok: true }
  | { ok: false; message: string } {
  for (const file of files) {
    if (!file.buffer?.length) continue;
    const ext = resolveUploadExtension(file);
    if (isBlockedUploadExtension(ext)) {
      return { ok: false, message: `${label} file type is not allowed.` };
    }
    if (!isAcceptablePdfUpload(file)) {
      return { ok: false, message: `${label} must be a PDF file.` };
    }
  }
  return { ok: true };
}
