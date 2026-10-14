import { normalizeDealGallerySrc } from "@/common/utils/apiBaseUrl"
import {
  isAutoManagedDocumentsSection,
  isInvestorEsignWorkspaceDocument,
  readDealDocumentSectionsForWorkspace,
  sectionDisplayLabel,
  type NestedPreviewDocument,
  type OfferingPreviewSection,
} from "../../utils/offeringPreviewDocSections"

export type DealDocumentPickOption = {
  id: string
  name: string
  url: string
  sectionLabel: string
}

function isPdfFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".pdf")
}

function resolveDealDocumentUrl(doc: NestedPreviewDocument): string {
  const raw = doc.url?.trim() ?? ""
  if (!raw) return ""
  return normalizeDealGallerySrc(raw).trim() || raw
}

/**
 * Auto-managed sections hold investor-completed eSign PDFs and the generated
 * Funding Information PDF — neither is a valid base document for a template.
 */
function isTemplateSourceSection(section: OfferingPreviewSection): boolean {
  return !isAutoManagedDocumentsSection(section)
}

function isTemplateSourceDocument(doc: NestedPreviewDocument): boolean {
  return !isInvestorEsignWorkspaceDocument(doc)
}

/** Any usable file on this deal's Documents tab (enables the Deal documents toggle). */
export function dealHasAnySectionDocuments(dealId: string): boolean {
  for (const section of readDealDocumentSectionsForWorkspace(dealId)) {
    if (!isTemplateSourceSection(section)) continue
    if (section.nestedDocuments.some(isTemplateSourceDocument)) return true
  }
  return false
}

function pdfFileNameFromDocument(doc: NestedPreviewDocument): string {
  const base = doc.name.trim() || "document"
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`
}

/**
 * PDFs on this deal's Documents tab that can seed an eSign template (deal-scoped).
 * Investor-signed eSign PDFs and auto-generated section files are left out.
 */
export function listDealPdfDocumentsForEsignTemplate(
  dealId: string,
): DealDocumentPickOption[] {
  const id = (dealId ?? "").trim()
  if (!id) return []
  const out: DealDocumentPickOption[] = []
  for (const section of readDealDocumentSectionsForWorkspace(id)) {
    if (!isTemplateSourceSection(section)) continue
    const sectionLabel = sectionDisplayLabel(section)
    for (const doc of section.nestedDocuments) {
      if (!doc.id?.trim() || !doc.name?.trim()) continue
      if (!isTemplateSourceDocument(doc)) continue
      const url = resolveDealDocumentUrl(doc)
      if (!url) continue
      if (!isPdfFileName(doc.name) && !url.toLowerCase().includes(".pdf")) continue
      out.push({
        id: doc.id,
        name: pdfFileNameFromDocument(doc),
        url,
        sectionLabel,
      })
    }
  }
  return out.sort((a, b) =>
    `${a.sectionLabel} ${a.name}`.localeCompare(`${b.sectionLabel} ${b.name}`, undefined, {
      sensitivity: "base",
    }),
  )
}

export async function fetchDealDocumentAsPdfFile(
  option: Pick<DealDocumentPickOption, "url" | "name">,
): Promise<File> {
  const resolved = normalizeDealGallerySrc(option.url)
  if (!resolved) throw new Error("Document URL is missing.")
  const res = await fetch(resolved, { credentials: "include" })
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "Document file was not found on the server."
        : "Could not download the selected document.",
    )
  }
  const blob = await res.blob()
  const type =
    blob.type && blob.type !== "application/octet-stream"
      ? blob.type
      : "application/pdf"
  return new File([blob], option.name, { type })
}
