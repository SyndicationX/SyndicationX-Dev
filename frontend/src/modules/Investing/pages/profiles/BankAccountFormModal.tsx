import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Building2, CircleDollarSign, Fingerprint, IdCard, Loader2, MapPin, Save, X } from "lucide-react"
import { toast } from "@/common/components/Toast"
import { DealsCreateDropdownSelect } from "@/modules/Syndication/Deals/components/DealsCreateDropdownSelect"
import { putInvestorProfile } from "./investingProfileBookApi"
import type { InvestorProfileListRow } from "./investor-profiles.types"
import { InvestingFormField } from "./InvestingFormField"
import "@/modules/Syndication/Deals/components/deals-create-dropdown.css"
import "@/modules/Syndication/Deals/tabs/investors/add-investment-modal.css"
import "@/modules/Syndication/contacts/contacts.css"
import "./add-investor-profile-modal.css"
import "./investing-profiles-form-modals.css"

const ACCOUNT_TYPES = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
]

const INPUT_CLASS = "deals_add_inv_input deals_add_inv_field_control deals_add_inv_field_pill"

type FieldErrors = {
  bankName?: string
  accountType?: string
  routing?: string
  account?: string
  address?: string
}

function digits(value: string): string {
  return value.replace(/\D/g, "")
}

function wizardSnapshot(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return { ...(raw as Record<string, unknown>) }
}

/** Bank-only form. Saves the account on the profile without opening the profile editor. */
export function BankAccountFormModal({
  open,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean
  profile: InvestorProfileListRow | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [bankName, setBankName] = useState("")
  const [accountType, setAccountType] = useState("")
  const [routing, setRouting] = useState("")
  const [account, setAccount] = useState("")
  const [address, setAddress] = useState("")
  const [errors, setErrors] = useState<FieldErrors>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !profile) return
    const bank = profile.distributionBank
    setBankName(bank?.achBankName ?? "")
    setAccountType(bank?.achBankAccountType ?? "")
    setRouting(digits(bank?.achRoutingNumber ?? ""))
    setAccount(bank?.achAccountNumber ?? "")
    setAddress(bank?.achBankAddress ?? "")
    setErrors({})
    setBusy(false)
  }, [open, profile])

  if (!open || !profile) return null

  async function save() {
    if (!profile) return
    const nextErrors: FieldErrors = {}
    if (!bankName.trim()) nextErrors.bankName = "Enter the bank name."
    if (accountType !== "checking" && accountType !== "savings") {
      nextErrors.accountType = "Select checking or savings."
    }
    if (digits(routing).length !== 9) nextErrors.routing = "Enter a 9-digit routing number."
    if (digits(account).length < 4) nextErrors.account = "Enter the account number."
    if (!address.trim()) nextErrors.address = "Enter the bank address."
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setBusy(true)
    try {
      const snapshot = wizardSnapshot(profile.profileWizardState)
      const existing = profile.distributionBank
      if (existing) {
        snapshot.distributionMethod =
          snapshot.distributionMethod || existing.distributionMethod || "ach"
        snapshot.checkPayeeName = snapshot.checkPayeeName ?? existing.checkPayeeName
        snapshot.checkMailingAddressId =
          snapshot.checkMailingAddressId ?? existing.checkMailingAddressId
        snapshot.bankAccountQuery = snapshot.bankAccountQuery ?? existing.bankAccountQuery
      }
      snapshot.distributionMethod = "ach"
      snapshot.achBankName = bankName.trim()
      snapshot.achBankAccountType = accountType
      snapshot.achRoutingNumber = digits(routing)
      snapshot.achAccountNumber = digits(account)
      snapshot.achBankAddress = address.trim()
      await putInvestorProfile(profile.id, {
        profileName: profile.profileName,
        profileType: profile.profileType,
        lastEditReason: "Updated bank account",
        profileWizardState: snapshot,
      })
      toast.success("Bank account saved", "The account is on file for distributions.")
      await onSaved()
      onClose()
    } catch (err) {
      toast.error(
        "Could not save bank account",
        err instanceof Error ? err.message : "Please try again.",
      )
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="um_modal_overlay deals_add_inv_modal_overlay investing_ben_modal_overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="um_modal um_modal_view deals_add_inv_modal_panel add_contact_panel investing_add_profile_form_panel investing_bank_form_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bank-account-form-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="um_modal_head add_contact_modal_head">
          <div className="add_contact_modal_head_main">
            <h2 id="bank-account-form-title" className="um_modal_title add_contact_modal_title">
              Bank account
            </h2>
            <p className="investing_bank_form_sub">
              Bank name, account, and routing only.
            </p>
          </div>
          <button
            type="button"
            className="um_modal_close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <form
          className="add_contact_form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="um_modal_body add_contact_modal_body">
            <div className="add_contact_section">
              <InvestingFormField
                id="bank-form-name"
                label="Bank"
                Icon={Building2}
                error={errors.bankName}
              >
                <input
                  id="bank-form-name"
                  className={INPUT_CLASS}
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="Bank name"
                  autoComplete="organization"
                />
              </InvestingFormField>
              <InvestingFormField
                id="bank-form-type"
                label="Account type"
                Icon={CircleDollarSign}
                error={errors.accountType}
                tight
              >
                <DealsCreateDropdownSelect
                  id="bank-form-type"
                  options={ACCOUNT_TYPES}
                  value={accountType}
                  onChange={setAccountType}
                  placeholder="Checking or savings"
                  ariaLabel="Account type"
                  triggerClassName="deals_add_inv_field_control deals_add_inv_field_pill"
                />
              </InvestingFormField>
              <div className="add_contact_name_grid">
                <InvestingFormField
                  id="bank-form-routing"
                  label="Routing"
                  Icon={Fingerprint}
                  error={errors.routing}
                  tight
                >
                  <input
                    id="bank-form-routing"
                    className={INPUT_CLASS}
                    value={routing}
                    onChange={(e) => setRouting(digits(e.target.value).slice(0, 9))}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="9 digits"
                  />
                </InvestingFormField>
                <InvestingFormField
                  id="bank-form-account"
                  label="Account"
                  Icon={IdCard}
                  error={errors.account}
                  tight
                >
                  <input
                    id="bank-form-account"
                    className={`${INPUT_CLASS} add_profile_account_number`}
                    value={account}
                    onChange={(e) => setAccount(digits(e.target.value).slice(0, 17))}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Account number"
                  />
                </InvestingFormField>
              </div>
              <InvestingFormField
                id="bank-form-address"
                label="Bank address"
                Icon={MapPin}
                error={errors.address}
              >
                <input
                  id="bank-form-address"
                  className={INPUT_CLASS}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Bank address"
                  autoComplete="street-address"
                />
              </InvestingFormField>
            </div>
          </div>
          <div className="um_modal_actions add_contact_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Cancel
            </button>
            <button type="submit" className="um_btn_primary" disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={16} strokeWidth={2} aria-hidden />
                  Saving…
                </>
              ) : (
                <>
                  <Save size={16} strokeWidth={2} aria-hidden />
                  Save bank account
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
