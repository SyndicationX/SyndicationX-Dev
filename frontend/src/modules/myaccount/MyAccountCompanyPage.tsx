import type { FormEvent } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  Building2,
  CircleUser,
  Eye,
  Loader2,
  Rocket,
  Save,
  Shield,
} from "lucide-react"
import { usePortalMode } from "@/modules/Investing/context/PortalModeContext"
import { refreshAuthTokens } from "../../common/auth/authTokensApi"
import { COMPANY_ADMIN, INVESTOR } from "../../common/auth/roleUtils"
import { RadioPillGroup } from "../../common/components/radio-pill-group/RadioPillGroup"
import { fetchMyProfile, patchMyProfile } from "./accountApi"
import {
  orgRoleLabelForMyAccount,
  viewerShowsOrgRoleInMyAccount,
} from "./myAccountOrgRole"
import { canSetPlatformVisibility } from "./myAccountIndividual"
import { profileRoleLabelForMyAccount } from "./myAccountProfileRole"
import { MyAccountPanelLoader } from "./MyAccountPanelLoader"
import {
  getActiveWorkspaceCompanyName,
  getSessionOrganizationCompanyId,
} from "../../common/auth/sessionOrganization"
import { patchCompanyDisplayName } from "../Syndication/company/companyWorkspaceSettingsApi"
import { PORTAL_ACTIVE_COMPANY_CHANGED_EVENT } from "../../common/auth/setActiveCompany"
import { toast } from "../../common/components/Toast"
import { mergeSessionUserDetails, readSessionUser } from "./sessionUser"

const START_SYNDICATING_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const

const VISIBLE_TO_USERS_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const

type StartSyndicatingChoice = "yes" | "no"
type VisibleToUsersChoice = "yes" | "no"

function sessionRole(u: Record<string, unknown> | null): string {
  return String(u?.role ?? "").trim()
}

function visibleToUsersChoiceFromUser(
  u: Record<string, unknown> | null,
): VisibleToUsersChoice {
  const raw = u?.visibleToUsers ?? u?.visible_to_users
  if (raw === true || raw === 1) return "yes"
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase()
    if (normalized === "true" || normalized === "yes" || normalized === "1") {
      return "yes"
    }
  }
  return "no"
}

export function MyAccountCompanyPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { mode: portalMode, switchToSyndicating } = usePortalMode()
  const [companyName, setCompanyName] = useState("")
  const [initialCompanyName, setInitialCompanyName] = useState("")
  const [sessionUser, setSessionUser] = useState<Record<string, unknown> | null>(
    () => readSessionUser(),
  )
  const [startSyndicating, setStartSyndicating] =
    useState<StartSyndicatingChoice>("no")
  const [showVisibleToUsers, setShowVisibleToUsers] = useState(false)
  const [visibleToUsers, setVisibleToUsers] =
    useState<VisibleToUsersChoice>("no")
  const [initialVisibleToUsers, setInitialVisibleToUsers] =
    useState<VisibleToUsersChoice>("no")
  const [error, setError] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const portalRoleLabel = profileRoleLabelForMyAccount(portalMode)
  const showOrgRole = viewerShowsOrgRoleInMyAccount(sessionUser)
  const orgRoleLabel = orgRoleLabelForMyAccount(sessionUser)
  const isInvestorAccount = sessionRole(sessionUser) === INVESTOR
  const canRenameOrgCompany = sessionRole(sessionUser) === COMPANY_ADMIN
  const canEditCompanyName = isInvestorAccount || canRenameOrgCompany

  const loadFromSession = useCallback(() => {
    const u = readSessionUser()
    setSessionUser(u)
    const name = getActiveWorkspaceCompanyName()
    const visibility = visibleToUsersChoiceFromUser(u)
    setCompanyName(name)
    setInitialCompanyName(name)
    setShowVisibleToUsers(canSetPlatformVisibility(u))
    setVisibleToUsers(visibility)
    setInitialVisibleToUsers(visibility)
  }, [])

  const hasChanges = useMemo(
    () =>
      companyName.trim() !== initialCompanyName.trim() ||
      startSyndicating === "yes" ||
      (showVisibleToUsers && visibleToUsers !== initialVisibleToUsers),
    [
      companyName,
      initialCompanyName,
      startSyndicating,
      showVisibleToUsers,
      visibleToUsers,
      initialVisibleToUsers,
    ],
  )

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    loadFromSession()
    void fetchMyProfile().then((user) => {
      if (cancelled) return
      if (user) mergeSessionUserDetails(user)
      loadFromSession()
      setIsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [location.pathname, loadFromSession])

  useEffect(() => {
    function onSessionUserUpdated() {
      loadFromSession()
    }
    function onActiveCompanyChanged() {
      loadFromSession()
    }
    window.addEventListener("portal-session-user-updated", onSessionUserUpdated)
    window.addEventListener(PORTAL_ACTIVE_COMPANY_CHANGED_EVENT, onActiveCompanyChanged)
    return () => {
      window.removeEventListener(
        "portal-session-user-updated",
        onSessionUserUpdated,
      )
      window.removeEventListener(
        PORTAL_ACTIVE_COMPANY_CHANGED_EVENT,
        onActiveCompanyChanged,
      )
    }
  }, [loadFromSession])

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!hasChanges || isSaving) return
    const name = companyName.trim()
    const companyNameChanged = name !== initialCompanyName.trim()
    const wantsSyndicating = startSyndicating === "yes"
    const visibilityChanged =
      showVisibleToUsers && visibleToUsers !== initialVisibleToUsers
    const needsCompanyName = companyNameChanged || wantsSyndicating
    if (needsCompanyName && !canEditCompanyName) return
    if (needsCompanyName && !name) {
      setError("Enter a company name.")
      return
    }
    setError("")
    setIsSaving(true)
    try {
      let companyNameSaved = false
      if (canRenameOrgCompany && companyNameChanged) {
        const companyId = getSessionOrganizationCompanyId()
        if (!companyId) {
          setError("Company workspace is not available.")
          return
        }
        const result = await patchCompanyDisplayName(companyId, name)
        if (!result.ok) {
          setError(result.message)
          toast.error("Could not update company name", result.message)
          return
        }
        const saved = result.name
        mergeSessionUserDetails({
          companyName: saved,
          company_name: saved,
          organizationName: saved,
          organization_name: saved,
        })
        const session = readSessionUser()
        if (session && Array.isArray(session.memberships)) {
          const id = companyId.trim().toLowerCase()
          mergeSessionUserDetails({
            memberships: session.memberships.map((item) => {
              if (item == null || typeof item !== "object" || Array.isArray(item)) {
                return item
              }
              const rec = item as Record<string, unknown>
              const recId = String(
                rec.companyId ?? rec.company_id ?? "",
              )
                .trim()
                .toLowerCase()
              if (recId !== id) return item
              return {
                ...rec,
                companyName: saved,
                company_name: saved,
                company: saved,
                organization_name: saved,
              }
            }),
          })
        }
        loadFromSession()
        window.dispatchEvent(new CustomEvent(PORTAL_ACTIVE_COMPANY_CHANGED_EVENT))
        companyNameSaved = true
      }

      let joinedExistingCompany = false
      if (!canRenameOrgCompany || visibilityChanged) {
        const savedVisibility =
          visibilityChanged ? visibleToUsers === "yes" : undefined
        const profilePatch: Parameters<typeof patchMyProfile>[0] = {
          ...(canRenameOrgCompany || !needsCompanyName
            ? {}
            : { companyName: name }),
          ...(wantsSyndicating ? { startSyndicating: true } : {}),
          ...(visibilityChanged
            ? { visibleToUsers: visibleToUsers === "yes" }
            : {}),
        }
        const { user, joinedExistingCompany: joined, startedSyndicating } =
          await patchMyProfile(profilePatch)
        joinedExistingCompany = Boolean(joined)
        mergeSessionUserDetails({
          ...user,
          ...(savedVisibility === undefined
            ? {}
            : {
                visibleToUsers: savedVisibility,
                visible_to_users: savedVisibility,
              }),
        })
        loadFromSession()
        if (startedSyndicating) {
          // New role lives in the access token, so mint a fresh pair before the
          // syndicating workspace loads.
          await refreshAuthTokens()
          const refreshed = await fetchMyProfile()
          if (refreshed) mergeSessionUserDetails(refreshed)
          setStartSyndicating("no")
          toast.success(
            "Syndicating is on",
            `You can now run deals for ${name}.`,
          )
          switchToSyndicating()
          navigate("/dashboard", { replace: true })
          return
        }
      }

      if (companyNameSaved && !visibilityChanged) {
        toast.success("Saved", "Company name updated.")
      } else if (!canRenameOrgCompany && companyNameChanged) {
        toast.success(
          "Company details saved",
          joinedExistingCompany
            ? `This company already exists. Your account was added to ${name}.`
            : `${name} was created and linked to your account.`,
        )
      } else {
        toast.success("Company details saved", "Your details were updated.")
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save company details.",
      )
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) return <MyAccountPanelLoader label="Loading company details…" />

  return (
    <div className="myaccount_form_body myaccount_form_body--grid">
      {error ? (
        <p className="um_msg_error" role="alert">
          {error}
        </p>
      ) : null}
      <form className="myaccount_fields_grid" onSubmit={handleSubmit} noValidate>
        <div className="um_field">
          <label htmlFor="myaccount-companyName" className="um_field_label_row">
            <Building2 className="um_field_label_icon" size={17} aria-hidden />
            <span>Company name</span>
          </label>
          <input
            id="myaccount-companyName"
            name="companyName"
            type="text"
            value={companyName}
            onChange={(e) => {
              if (!canEditCompanyName) return
              setCompanyName(e.target.value)
              if (error) setError("")
            }}
            placeholder={
              canEditCompanyName ? "Your company name" : undefined
            }
            readOnly={!canEditCompanyName}
            disabled={isSaving}
            autoComplete="organization"
          />
        </div>
        <div className="um_field">
          <label htmlFor="myaccount-portal-role" className="um_field_label_row">
            <CircleUser className="um_field_label_icon" size={17} aria-hidden />
            <span>Profile Role</span>
          </label>
          <input
            id="myaccount-portal-role"
            name="portalRole"
            type="text"
            value={portalRoleLabel}
            onChange={() => {}}
            readOnly
            autoComplete="off"
          />
        </div>
        {showOrgRole ? (
          <div className="um_field">
            <label
              htmlFor="myaccount-company-org-role"
              className="um_field_label_row"
            >
              <Shield className="um_field_label_icon" size={17} aria-hidden />
              <span>Org Role</span>
            </label>
            <input
              id="myaccount-company-org-role"
              name="orgRole"
              type="text"
              value={orgRoleLabel}
              onChange={() => {}}
              readOnly
              autoComplete="off"
            />
          </div>
        ) : null}
        {showVisibleToUsers ? (
          <section
            className="um_panel myaccount_question_card"
            aria-labelledby="myaccount-visible-to-users-label"
          >
            <p
              id="myaccount-visible-to-users-label"
              className="um_field_label_row"
            >
              <Eye className="um_field_label_icon" size={17} aria-hidden />
              <span>Do you want to be visible to users?</span>
            </p>
            <p className="myaccount_field_hint">
              Choose Yes to appear for all platform users under Contacts →
              Platform Contacts.
            </p>
            <fieldset
              className="myaccount_question_fieldset"
              disabled={isSaving}
            >
              <RadioPillGroup
                name="myaccount-visible-to-users"
                value={visibleToUsers}
                options={VISIBLE_TO_USERS_OPTIONS}
                onChange={(next) => {
                  setVisibleToUsers(next)
                  if (error) setError("")
                }}
                ariaLabelledBy="myaccount-visible-to-users-label"
              />
            </fieldset>
          </section>
        ) : null}
        {isInvestorAccount ? (
          <section
            className="um_panel myaccount_question_card"
            aria-labelledby="myaccount-start-syndicating-label"
          >
            <p
              id="myaccount-start-syndicating-label"
              className="um_field_label_row"
            >
              <Rocket className="um_field_label_icon" size={17} aria-hidden />
              <span>Do you want to start syndicating?</span>
            </p>
            <p className="myaccount_field_hint">
              {companyName.trim()
                ? "Choose Yes to open the syndicating workspace for this company and raise your own deals."
                : "Add your company name above first, then choose Yes to open the syndicating workspace."}
            </p>
            <fieldset
              className="myaccount_question_fieldset"
              disabled={isSaving || !companyName.trim()}
            >
              <RadioPillGroup
                name="myaccount-start-syndicating"
                value={startSyndicating}
                options={START_SYNDICATING_OPTIONS}
                onChange={(next) => {
                  setStartSyndicating(next)
                  if (error) setError("")
                }}
                ariaLabelledBy="myaccount-start-syndicating-label"
              />
            </fieldset>
          </section>
        ) : null}
        {canEditCompanyName || showVisibleToUsers ? (
          <div className="myaccount_actions">
            <button
              type="submit"
              className="um_btn_primary"
              disabled={
                isSaving ||
                !hasChanges ||
                ((companyName.trim() !== initialCompanyName.trim() ||
                  startSyndicating === "yes") &&
                  !companyName.trim())
              }
            >
              {isSaving ? (
                <>
                  <Loader2
                    size={16}
                    strokeWidth={2}
                    className="myaccount_btn_spin"
                    aria-hidden
                  />
                  Saving…
                </>
              ) : (
                <>
                  <Save size={16} strokeWidth={2} aria-hidden />
                  Save changes
                </>
              )}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  )
}
