import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileSpreadsheet,
  Link2,
  Loader2,
  SkipForward,
  Upload,
  X,
} from "lucide-react"
import { Fragment, useMemo, useState, type ChangeEvent } from "react"
import { useNavigate } from "react-router-dom"
import { CardRadioGroup } from "../../../common/components/CardRadioGroup/CardRadioGroup"
import { toast } from "../../../common/components/Toast"
import "../Deals/tabs/deal_members/add-investment/add_deal_modal.css"
import "../usermanagement/user_management.css"
import "./contacts.css"
import {
  confirmContactImport,
  parseContactImportFile,
  previewContactImport,
} from "./api/contactsApi"
import type {
  ContactImportDuplicateMode,
  ContactImportField,
  ContactImportMapping,
  ContactImportParseResult,
  ContactImportPreviewResult,
} from "./types/contactImport.types"

const IMPORT_FIELDS: Array<{ field: ContactImportField; label: string; required?: boolean }> = [
  { field: "firstName", label: "First Name", required: true },
  { field: "lastName", label: "Last Name" },
  { field: "fullName", label: "Full Name" },
  { field: "email", label: "Email", required: true },
  { field: "phone", label: "Phone" },
  { field: "note", label: "Note" },
  { field: "tags", label: "Tags" },
  { field: "lists", label: "Lists" },
]

const IMPORT_STEPS = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Map" },
  { id: "preview", label: "Preview" },
  // { id: "success", label: "Done" },
] as const

type ImportStep = (typeof IMPORT_STEPS)[number]["id"]

function countLabel(value: number, label: string): string {
  return `${value.toLocaleString()} ${label}`
}

function previewName(row: ContactImportPreviewResult["rows"][number]): string {
  const n = row.normalized
  if (!n) return "Unmapped row"
  return [n.firstName, n.lastName].filter(Boolean).join(" ") || n.email
}

function statusLabel(status: string): string {
  if (status === "valid") return "New"
  return status
}

type ContactImportWizardProps = {
  mode?: "page" | "modal"
  onClose?: () => void
}

function ImportStepper({ step }: { step: ImportStep }) {
  const current = IMPORT_STEPS.findIndex((item) => item.id === step)
  return (
    <div className="add_contact_stepper" role="group" aria-label="Import progress">
      {IMPORT_STEPS.map((item, index) => {
        const done = index < current
        const active = index === current
        return (
          <Fragment key={item.id}>
            {index > 0 ? (
              <span
                className={
                  index <= current
                    ? "add_contact_step_line add_contact_step_line_active"
                    : "add_contact_step_line"
                }
                aria-hidden
              />
            ) : null}
            <div
              className={[
                "add_contact_step_node",
                active ? "add_contact_step_node_active" : "",
                done ? "add_contact_step_node_done" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span
                className="add_contact_step_dot"
                aria-current={active ? "step" : undefined}
              >
                {index + 1}
              </span>
              <span className="add_contact_step_label">{item.label}</span>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

export function ContactImportWizard({
  mode = "page",
  onClose,
}: ContactImportWizardProps) {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<ContactImportParseResult | null>(null)
  const [mapping, setMapping] = useState<ContactImportMapping>({})
  const [preview, setPreview] = useState<ContactImportPreviewResult | null>(null)
  const [duplicateMode, setDuplicateMode] =
    useState<ContactImportDuplicateMode>("skip")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [complete, setComplete] = useState(false)

  const headers = parseResult?.headers ?? []
  const canPreview = Boolean(parseResult?.batchId && mapping.email)
  const canImport =
    Boolean(preview) && !complete && (preview?.counts.invalidRows ?? 0) < (preview?.counts.totalRows ?? 0)
  const step: ImportStep = preview
    ? "preview"
    : parseResult
      ? "mapping"
      : "upload"

  const requiredHint = useMemo(() => {
    if (!parseResult) return ""
    const hasName = Boolean(mapping.fullName || mapping.firstName)
    if (!hasName) return "Map Full Name or First Name."
    if (!mapping.email) return "Map Email before previewing."
    return ""
  }, [mapping.email, mapping.firstName, mapping.fullName, parseResult])

  async function handleParse() {
    if (!file) {
      setError("Choose a CSV or Excel file first.")
      return
    }
    setBusy(true)
    setError("")
    setPreview(null)
    setComplete(false)
    try {
      const result = await parseContactImportFile(file)
      setParseResult(result)
      setMapping(result.suggestedMapping)
      toast.success("File parsed", `${result.totalRows.toLocaleString()} rows found`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse file.")
    } finally {
      setBusy(false)
    }
  }

  async function handlePreview() {
    if (!parseResult) return
    if (requiredHint) {
      setError(requiredHint)
      return
    }
    setBusy(true)
    setError("")
    try {
      const result = await previewContactImport({
        batchId: parseResult.batchId,
        mapping,
      })
      setPreview(result)
      toast.success("Preview ready", countLabel(result.counts.totalRows, "rows checked"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not preview import.")
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm() {
    if (!parseResult) return
    setBusy(true)
    setError("")
    try {
      const result = await confirmContactImport({
        batchId: parseResult.batchId,
        duplicateMode,
      })
      setPreview(result)
      setComplete(true)
      toast.success(
        "Contacts imported",
        `${result.counts.importedRows + result.counts.updatedRows} contacts changed`,
      )
      closeImport()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import contacts.")
    } finally {
      setBusy(false)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null
    setFile(next)
    setParseResult(null)
    setPreview(null)
    setComplete(false)
    setError("")
  }

  function closeImport() {
    if (onClose) {
      onClose()
      return
    }
    navigate("/contacts")
  }

  function mappedFieldForHeader(header: string): ContactImportField | "" {
    const match = IMPORT_FIELDS.find(({ field }) => mapping[field] === header)
    return match?.field ?? ""
  }

  function updateHeaderMapping(header: string, nextField: ContactImportField | "") {
    setMapping((prev) => {
      const next: ContactImportMapping = { ...prev }
      for (const { field } of IMPORT_FIELDS) {
        if (next[field] === header || field === nextField) {
          next[field] = null
        }
      }
      if (nextField) next[nextField] = header
      return next
    })
    setPreview(null)
    setComplete(false)
  }

  const body = (
    <>
      {error ? (
        <p className="um_msg_error um_modal_form_error" role="alert">
          {error}
        </p>
      ) : null}

      {step === "upload" ? (
        <div className="add_contact_section">
          <p className="add_contact_section_eyebrow">Upload file</p>
          <p className="contact_import_hint">
            Supports CSV and Excel (`.csv`, `.xlsx`, `.xls`). After upload, map
            spreadsheet columns to contact fields.
          </p>
          <label className="contact_import_file_drop">
            <Upload size={22} strokeWidth={1.75} aria-hidden />
            <span className="contact_import_file_drop_title">
              {file ? "Replace file" : "Choose contact file"}
            </span>
            <span className="contact_import_file_drop_meta">
              Click to browse your computer
            </span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={handleFileChange}
            />
          </label>
          {file ? (
            <div className="contact_import_file_name">
              <FileSpreadsheet size={18} strokeWidth={2} aria-hidden />
              <span>{file.name}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === "mapping" && parseResult ? (
        <div className="add_contact_section">
          <p className="add_contact_section_eyebrow">Map columns</p>
          <div className="contact_import_success_note">
            <CheckCircle2 size={17} strokeWidth={2} aria-hidden />
            <span>
              Uploaded {file?.name ?? "file"} with {parseResult.headers.length}{" "}
              columns and {parseResult.totalRows.toLocaleString()} rows.
            </span>
          </div>
          <p className="contact_import_hint">
            For each spreadsheet column, choose the contact field it should
            import into. Leave a column unmapped to skip it. Email is required,
            plus Full Name or First Name. Last Name is optional.
          </p>
          <div className="contact_import_mapping_list">
            {headers.map((header) => (
              <div className="contact_import_mapping_row" key={header}>
                <div className="contact_import_excel_column">
                  <span className="contact_import_mapping_label">Spreadsheet column</span>
                  <strong>{header}</strong>
                </div>
                <ArrowRight
                  className="contact_import_mapping_arrow"
                  size={18}
                  strokeWidth={2}
                  aria-hidden
                />
                <label className="contact_import_map_to um_field">
                  <span className="contact_import_mapping_label">
                    <Link2 size={14} strokeWidth={2} aria-hidden />
                    Contact field
                  </span>
                  <select
                    className="um_field_select deals_add_inv_field_control"
                    value={mappedFieldForHeader(header)}
                    onChange={(event) =>
                      updateHeaderMapping(
                        header,
                        event.target.value as ContactImportField | "",
                      )
                    }
                    aria-label={`Map ${header}`}
                  >
                    <option value="">Do not import</option>
                    {IMPORT_FIELDS.map(({ field, label, required }) => (
                      <option value={field} key={`${header}-${field}`}>
                        {label}
                        {required ? " *" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
          {requiredHint ? (
            <p className="contact_import_required_hint">{requiredHint}</p>
          ) : null}
        </div>
      ) : null}

      {step === "preview" && preview ? (
        <div className="add_contact_section">
          <p className="add_contact_section_eyebrow">Preview and import</p>
          <div className="contact_import_stats">
            <span className="contact_import_stat contact_import_stat_new">
              {countLabel(preview.counts.newRows, "new")}
            </span>
            <span className="contact_import_stat contact_import_stat_duplicate">
              {countLabel(preview.counts.duplicateRows, "duplicates")}
            </span>
            <span className="contact_import_stat contact_import_stat_invalid">
              {countLabel(preview.counts.invalidRows, "invalid")}
            </span>
          </div>

          <div className="um_field contact_import_duplicate_field">
            <div className="um_field_label_row" id="contact-import-duplicates-label">
              <Copy className="um_field_label_icon" size={17} strokeWidth={2} aria-hidden />
              <span>Duplicates</span>
            </div>
            <CardRadioGroup
              name="contact-import-duplicates"
              ariaLabelledBy="contact-import-duplicates-label"
              value={duplicateMode}
              onChange={(value) => setDuplicateMode(value as ContactImportDuplicateMode)}
              options={[
                { value: "skip", label: "Skip existing", icon: SkipForward },
                { value: "update", label: "Update existing", icon: Copy },
              ]}
            />
          </div>

          <div className="um_table_wrap contact_import_table_wrap">
            <table className="um_table contact_import_table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.id} className={`contact_import_row_${row.status}`}>
                    <td>{row.rowIndex}</td>
                    <td>{previewName(row)}</td>
                    <td>{row.normalized?.email || "—"}</td>
                    <td>{row.normalized?.phone || "—"}</td>
                    <td>
                      <span className={`contact_import_status contact_import_status_${row.status}`}>
                        {statusLabel(row.status)}
                        {row.duplicateMatch ? ` (${row.duplicateMatch})` : ""}
                      </span>
                    </td>
                    <td>{row.errors.length ? row.errors.join(" ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* {step === "success" && preview ? (
        <div className="contact_import_success_panel">
          <CheckCircle2 size={36} strokeWidth={1.75} aria-hidden />
          <h2>Contacts imported</h2>
          <p>
            {countLabel(preview.counts.importedRows, "inserted")},{" "}
            {countLabel(preview.counts.updatedRows, "updated")}, and{" "}
            {countLabel(preview.counts.skippedRows, "skipped")}.
          </p>
        </div>
      ) : null} */}
    </>
  )

  const footer = (
    <div className="um_modal_actions add_contact_modal_actions">
      {/* {step === "success" ? (
        <button
          type="button"
          className="um_btn_secondary add_contact_modal_actions_leading"
          onClick={resetImport}
        >
          <Upload size={16} strokeWidth={2} aria-hidden />
          Import another file
        </button>
      ) : ( */}
        <button
          type="button"
          className="um_btn_secondary add_contact_modal_actions_leading"
          onClick={closeImport}
          disabled={busy}
        >
          <X size={16} strokeWidth={2} aria-hidden />
          Close
        </button>
      {/* )} */}
      <div className="add_contact_modal_actions_trailing">
        {step === "mapping" ? (
          <button
            type="button"
            className="um_btn_secondary"
            onClick={() => {
              setParseResult(null)
              setMapping({})
              setError("")
            }}
            disabled={busy}
          >
            <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            Back
          </button>
        ) : null}
        {step === "preview" ? (
          <button
            type="button"
            className="um_btn_secondary"
            onClick={() => {
              setPreview(null)
              setError("")
            }}
            disabled={busy}
          >
            <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            Back
          </button>
        ) : null}
        {step === "upload" ? (
          <button
            type="button"
            className="um_btn_primary"
            onClick={handleParse}
            disabled={busy || !file}
          >
            {busy ? (
              <>
                <Loader2
                  size={16}
                  strokeWidth={2}
                  className="add_contact_modal_btn_spin"
                  aria-hidden
                />
                Uploading…
              </>
            ) : (
              <>
                Next
                <ChevronRight size={18} strokeWidth={2} aria-hidden />
              </>
            )}
          </button>
        ) : null}
        {step === "mapping" ? (
          <button
            type="button"
            className="um_btn_primary"
            onClick={handlePreview}
            disabled={busy || !canPreview}
          >
            {busy ? (
              <>
                <Loader2
                  size={16}
                  strokeWidth={2}
                  className="add_contact_modal_btn_spin"
                  aria-hidden
                />
                Checking…
              </>
            ) : (
              <>
                Next
                <ChevronRight size={18} strokeWidth={2} aria-hidden />
              </>
            )}
          </button>
        ) : null}
        {step === "preview" ? (
          <button
            type="button"
            className="um_btn_primary"
            onClick={handleConfirm}
            disabled={busy || !canImport}
          >
            {busy ? (
              <>
                <Loader2
                  size={16}
                  strokeWidth={2}
                  className="add_contact_modal_btn_spin"
                  aria-hidden
                />
                Importing…
              </>
            ) : (
              <>
                <Upload size={16} strokeWidth={2} aria-hidden />
                Import contacts
              </>
            )}
          </button>
        ) : null}
        {/* {step === "success" ? (
          <button type="button" className="um_btn_primary" onClick={closeImport}>
            Done
            <ChevronRight size={18} strokeWidth={2} aria-hidden />
          </button>
        ) : null} */}
      </div>
    </div>
  )

  if (mode === "modal") {
    return (
      <div className="contact_import_wizard deals_add_inv_modal_form">
        <div className="um_modal_head add_contact_modal_head">
          <div className="add_contact_modal_head_main">
            <h3 id="contact-import-title" className="um_modal_title add_contact_modal_title">
              Import contacts
            </h3>
            <ImportStepper step={step} />
          </div>
          <button
            type="button"
            className="um_modal_close"
            aria-label="Close"
            onClick={closeImport}
            disabled={busy}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <div className="deals_add_inv_modal_scroll">{body}</div>
        {footer}
      </div>
    )
  }

  return (
    <section className="um_page contacts_page contact_import_page">
      <header className="contact_import_header">
        <div>
          <button type="button" className="contact_import_back" onClick={closeImport}>
            <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            Back to contacts
          </button>
          <h1 className="contact_import_title">Import contacts</h1>
        </div>
      </header>
      <div className="contact_import_page_shell contact_import_wizard deals_add_inv_modal_form">
        <ImportStepper step={step} />
        <div className="deals_add_inv_modal_scroll">{body}</div>
        {footer}
      </div>
    </section>
  )
}

export default function ContactImportPage() {
  return <ContactImportWizard mode="page" />
}
