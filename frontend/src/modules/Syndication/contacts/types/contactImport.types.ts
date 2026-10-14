export type ContactImportField =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "note"
  | "tags"
  | "lists"

export type ContactImportMapping = Partial<Record<ContactImportField, string | null>>

export type ContactImportCounts = {
  totalRows: number
  newRows: number
  duplicateRows: number
  invalidRows: number
  importedRows: number
  skippedRows: number
  updatedRows: number
}

export type ContactImportNormalizedRow = {
  firstName: string
  lastName: string
  email: string
  phone: string
  note: string
  tags: string[]
  lists: string[]
  owners: string[]
  mappedFields: ContactImportField[]
}

export type ContactImportPreviewRow = {
  id: string
  rowIndex: number
  raw: Record<string, string>
  normalized: ContactImportNormalizedRow | null
  errors: string[]
  status: "valid" | "invalid" | "duplicate" | "imported" | "skipped" | "updated"
  duplicateContactId: string | null
  duplicateMatch: "email" | "phone" | null
}

export type ContactImportParseResult = {
  batchId: string
  headers: string[]
  suggestedMapping: ContactImportMapping
  sampleRows: Record<string, string>[]
  totalRows: number
}

export type ContactImportPreviewResult = {
  batchId: string
  counts: ContactImportCounts
  rows: ContactImportPreviewRow[]
}

export type ContactImportConfirmResult = ContactImportPreviewResult & {
  importedContactIds: string[]
}

export type ContactImportDuplicateMode = "skip" | "update"
