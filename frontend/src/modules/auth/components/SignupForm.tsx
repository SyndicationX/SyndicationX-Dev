import { useEffect, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowRight,
  Asterisk,
  Building2,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  Mail,
  Phone,
  User,
  Users,
} from "lucide-react";
import FooterForm from "../../../common/components/FooterForm";
import Input from "../../../common/components/Input";
import { UsPhoneInput } from "../../../common/components/UsPhoneInput";
import {
  AUTH_RETURN_NEXT_KEY,
  SESSION_ACTIVITY_SESSION_ID_KEY,
  SESSION_BEARER_KEY,
  SESSION_PORTAL_MODE_KEY,
  SESSION_USER_DETAILS_KEY,
} from "../../../common/auth/sessionKeys";
import { publishActiveBrowserUserFromSession } from "../../../common/auth/exclusiveBrowserSession";
import { isPlatformAdmin } from "../../../common/auth/roleUtils";
import { parseSafeNextPath } from "../../../common/auth/parseSafeNextPath";
import {
  isValidUsNanp10,
  national10ToE164,
  nationalDigitsFromStoredPhone,
  nationalTenDigitsFromRawInput,
} from "../../../common/phone/usPhoneNumber";
import { getApiV1Base } from "../../../common/utils/apiBaseUrl";
import { dealInvestNowPath } from "../../Syndication/Deals/utils/dealInvestNowPath";
import { consumeInvestNowIntent } from "../../Syndication/Deals/utils/investNowIntent";
import {
  applyOfferingPortfolioPostAuth,
  claimOfferingPortfolioAccess,
  consumeOfferingPortfolioAuthIntent,
  isPublicOfferingPortfolioReturnPath,
  readOfferingPortfolioAuthIntent,
  resolveOfferingPortfolioClaimIntent,
} from "../../Syndication/Deals/utils/offeringPortfolioAuthIntent";
import "./signup_form.css";
import { decodeJwtPayload } from "../utils/decode-jwt-payload";
import { toast } from "../../../common/components/Toast";

const LOGIN_PATH = "/signin";

type SignupAs = "" | "investor" | "syndicator" | "both";

const SIGNUP_AS_OPTIONS: { value: Exclude<SignupAs, "">; label: string }[] = [
  { value: "investor", label: "Investor" },
  { value: "syndicator", label: "Syndicator" },
  { value: "both", label: "Both" },
];

type SigninResponse = {
  message?: string;
  token?: string;
  accessToken?: string;
  userDetails?: unknown;
  activitySessionId?: string;
};

function normalizeApiBaseUrl(rawBase: string): string {
  const trimmed = String(rawBase ?? "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
  if (trimmed.startsWith("/")) {
    return `${window.location.origin}${trimmed}`.replace(/\/$/, "");
  }
  const hostLike = trimmed.replace(/^\/+/, "");
  return `${window.location.protocol}//${hostLike}`.replace(/\/$/, "");
}

function buildApiUrl(rawBase: string, path: string): URL | null {
  const base = normalizeApiBaseUrl(rawBase);
  if (!base) return null;
  try {
    const safePath = String(path ?? "").replace(/^\/+/, "");
    return new URL(safePath, `${base}/`);
  } catch {
    return null;
  }
}

export default function SignupForm() {
  const apiV1 = getApiV1Base();
  const navigate = useNavigate();
  const location = useLocation();
  const { token: tokenParam } = useParams();
  const [searchParams] = useSearchParams();
  const token = (tokenParam ?? "").trim() || searchParams.get("token")?.trim() || "";
  /** Sponsor's investor invite link — attributes this signup to them (see contacts page). */
  const inviteRef = searchParams.get("ref")?.trim() || "";
  const inviteSponsorName = searchParams.get("sponsorName")?.trim() || "";
  const inviteCompanyName = searchParams.get("companyName")?.trim() || "";
  /** Set when the link was emailed from Add Contact, so signup stays on that contact. */
  const invitedEmail =
    inviteRef && searchParams.get("email")?.trim()
      ? searchParams.get("email")!.trim().toLowerCase()
      : "";

  const [isVisible, setIsVisible] = useState(false);
  const [isVisibleConfirm, setIsVisibleConfirm] = useState(false);
  const [isError, setIsError] = useState("");
  const [successNotice, setSuccessNotice] = useState("");
  const [linkExpired, setLinkExpired] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [, setCrmPrefillNote] = useState(false);
  const [lockedPrefill, setLockedPrefill] = useState({
    firstName: false,
    lastName: false,
    phone: false,
  });

  const decode = token
    ? decodeJwtPayload<{
        email?: string;
        companyName?: string;
        exp?: number;
        typ?: string;
        dealId?: string;
      }>(token)
    : null;
  const decodeEmail = decode?.email ?? "";
  const decodeCompanyName = (decode?.companyName ?? "").trim();
  const dealInviteDealId = decode?.dealId?.trim() ?? "";
  const [resolvedInviteEmail, setResolvedInviteEmail] = useState(decodeEmail);
  const [resolvedInviteCompanyName, setResolvedInviteCompanyName] =
    useState(decodeCompanyName);
  const [resolvedInviteDealId, setResolvedInviteDealId] = useState(
    dealInviteDealId,
  );
  /** Deal email invite — scope prefill to this deal’s roster when deal invite context is available. */
  const dealIdForPrefillQuery = (
    decode?.typ === "deal_member_invite"
      ? resolvedInviteDealId || dealInviteDealId
      : resolvedInviteDealId
  ).trim();

  useEffect(() => {
    if (decodeEmail.trim()) setResolvedInviteEmail(decodeEmail.trim());
    if (decodeCompanyName.trim()) {
      setResolvedInviteCompanyName(decodeCompanyName.trim());
    }
    if (dealInviteDealId.trim()) setResolvedInviteDealId(dealInviteDealId.trim());
  }, [decodeEmail, decodeCompanyName, dealInviteDealId]);

  useEffect(() => {
    if (!apiV1 || !token || resolvedInviteEmail.trim()) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const u = buildApiUrl(apiV1, "auth/deal-invite/verify");
        if (!u) return;
        u.searchParams.set("token", token);
        const res = await fetch(u.toString(), { signal: ac.signal });
        const data = (await res.json().catch(() => ({}))) as {
          valid?: boolean;
          email?: string;
          companyName?: string;
          dealId?: string;
        };
        if (!res.ok || !data.valid) return;
        const em = String(data.email ?? "").trim().toLowerCase();
        const cn = String(data.companyName ?? "").trim();
        const did = String(data.dealId ?? "").trim();
        if (em) setResolvedInviteEmail(em);
        if (cn) setResolvedInviteCompanyName(cn);
        if (did) setResolvedInviteDealId(did);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    })();
    return () => ac.abort();
  }, [apiV1, token, resolvedInviteEmail]);

  useEffect(() => {
    if (resolvedInviteEmail) {
      setSignUpFormData((prev) => ({ ...prev, email: resolvedInviteEmail }));
    }
  }, [resolvedInviteEmail]);

  useEffect(() => {
    if (resolvedInviteCompanyName) {
      setSignUpFormData((prev) => ({
        ...prev,
        companyName: resolvedInviteCompanyName,
      }));
    }
  }, [resolvedInviteCompanyName]);

  useEffect(() => {
    if (!token) {
      setLinkExpired(false);
      return;
    }
    const d = decodeJwtPayload<{ exp?: number }>(token);
    if (d?.exp != null && d.exp < Date.now() / 1000) {
      setLinkExpired(true);
      return;
    }
    setLinkExpired(false);
  }, [token]);

  /**
   * Invite link: JWT carries email (and often company). Add Contact invitations
   * pass `ref` plus `email`. GET /auth/signup/prefill fills first name, last
   * name, and phone from that contact. With `dealId` (deal email invite), the
   * server prefers roster rows for that deal.
   */
  const prefillEmail = (resolvedInviteEmail || invitedEmail).trim().toLowerCase();
  useEffect(() => {
    if (!apiV1 || !prefillEmail) return;
    if (!token && !invitedEmail) return;
    if (token) {
      const d = decodeJwtPayload<{ exp?: number }>(token);
      if (d?.exp != null && d.exp < Date.now() / 1000) return;
    }

    const ac = new AbortController();
    void (async () => {
      try {
        const u = buildApiUrl(apiV1, "auth/signup/prefill");
        if (!u) {
          console.log("[signup-prefill] skipped apply", {
            reason: "invalid api base url",
            apiV1,
          });
          return;
        }
        u.searchParams.set("email", prefillEmail);
        if (dealIdForPrefillQuery) {
          u.searchParams.set("dealId", dealIdForPrefillQuery);
        }
        console.log("[signup-prefill] request", {
          url: u.toString(),
          tokenPresent: Boolean(token),
          inviteEmail: prefillEmail,
          dealId: dealIdForPrefillQuery || null,
        });
        const res = await fetch(u.toString(), { signal: ac.signal });
        const data = (await res.json().catch(() => ({}))) as {
          found?: boolean;
          firstName?: string;
          first_name?: string;
          lastName?: string;
          last_name?: string;
          userName?: string;
          username?: string;
          phone?: string;
          phoneNumber?: string;
          phone_number?: string;
        };
        console.log("[signup-prefill] response", {
          ok: res.ok,
          status: res.status,
          found: Boolean(data.found),
          raw: data,
        });
        if (!res.ok || !data.found) {
          console.log("[signup-prefill] skipped apply", {
            reason: !res.ok ? "non-ok response" : "found=false",
          });
          return;
        }
        const fn = (data.firstName ?? data.first_name ?? "").trim();
        const ln = (data.lastName ?? data.last_name ?? "").trim();
        const un = String(data.userName ?? data.username ?? "").trim();
        const ph = nationalDigitsFromStoredPhone(
          String(data.phone ?? data.phoneNumber ?? data.phone_number ?? ""),
        );
        console.log("[signup-prefill] normalized", {
          firstName: fn,
          lastName: ln,
          phoneDigits: ph,
        });
        const phOkPrefill = ph.length === 10 && isValidUsNanp10(ph);
        if (!fn && !ln && !ph) {
          console.log("[signup-prefill] skipped apply", {
            reason: "all normalized fields empty",
          });
          return;
        }
        setSignUpFormData((prev) => ({
          ...prev,
          firstName: fn || prev.firstName,
          lastName: ln || prev.lastName,
          userName: un || prev.userName,
          phone: phOkPrefill ? ph : prev.phone,
        }));
        setLockedPrefill((prev) => ({
          firstName: prev.firstName || Boolean(fn),
          lastName: prev.lastName || Boolean(ln),
          phone: prev.phone || phOkPrefill,
        }));
        setCrmPrefillNote(true);
        console.log("[signup-prefill] applied", {
          firstNameLocked: Boolean(fn),
          lastNameLocked: Boolean(ln),
          phoneLocked: phOkPrefill,
          crmPrefillNote: true,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.log("[signup-prefill] request failed", e);
      }
    })();
    return () => ac.abort();
  }, [apiV1, token, prefillEmail, invitedEmail, dealIdForPrefillQuery]);

  const [signUpFormData, setSignUpFormData] = useState<SignUpFormState>({
    email: resolvedInviteEmail || invitedEmail,
    companyName: "",
    signupAs: inviteRef ? "investor" : "",
    userName: "",
    phone: "",
    firstName: "",
    lastName: "",
    newPassword: "",
    confirmPassword: "",
  });

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const { name, value } = e.target;
    setSignUpFormData((prev) => ({ ...prev, [name]: value }));
    if (isError) setIsError("");
  }

  function handleSignupAsChange(value: SignupAs) {
    setSignUpFormData((prev) => ({
      ...prev,
      signupAs: value,
      ...(value === "investor" ? { companyName: "" } : {}),
    }));
    if (isError) setIsError("");
  }

  function passwordVisible() {
    setIsVisible((prev) => !prev);
  }

  function confirmPasswordVisible() {
    setIsVisibleConfirm((prev) => !prev);
  }

  const phoneNational = nationalTenDigitsFromRawInput(signUpFormData.phone);
  const phoneOk = isValidUsNanp10(phoneNational);

  const isSelfServeSignup = !token;
  const companyRequiredForRole =
    isSelfServeSignup &&
    (signUpFormData.signupAs === "syndicator" ||
      signUpFormData.signupAs === "both");
  const companyFieldEnabled =
    !isSelfServeSignup ||
    (Boolean(signUpFormData.signupAs) &&
      signUpFormData.signupAs !== "investor");
  const companyDisabledForInvestor =
    isSelfServeSignup && signUpFormData.signupAs === "investor";
  const requiredSignupFields = [
    signUpFormData.email,
    signUpFormData.phone,
    signUpFormData.firstName,
    signUpFormData.lastName,
    signUpFormData.newPassword,
    signUpFormData.confirmPassword,
    ...(isSelfServeSignup ? [signUpFormData.signupAs] : []),
    ...(companyRequiredForRole ? [signUpFormData.companyName] : []),
  ];
  const isDisabledBtn =
    requiredSignupFields.some((val) => val.trim() === "") ||
    !phoneOk ||
    isLoading ||
    !termsAccepted;

  function persistSigninSession(data: SigninResponse) {
    const accessToken = data.token?.trim() || data.accessToken?.trim()
    if (accessToken) {
      sessionStorage.setItem(SESSION_BEARER_KEY, accessToken);
    }
    if (data.userDetails != null) {
      const details = Array.isArray(data.userDetails)
        ? data.userDetails
        : [data.userDetails];
      sessionStorage.setItem(
        SESSION_USER_DETAILS_KEY,
        JSON.stringify(details),
      );
      publishActiveBrowserUserFromSession();
    } else {
      sessionStorage.removeItem(SESSION_USER_DETAILS_KEY);
    }
    if (
      typeof data.activitySessionId === "string" &&
      data.activitySessionId.trim()
    ) {
      sessionStorage.setItem(
        SESSION_ACTIVITY_SESSION_ID_KEY,
        data.activitySessionId.trim(),
      );
    } else {
      sessionStorage.removeItem(SESSION_ACTIVITY_SESSION_ID_KEY);
    }
  }

  function resolvePostAuthPath() {
    const portfolioIntent = consumeOfferingPortfolioAuthIntent();
    const storedIntent = consumeInvestNowIntent();
    const state = location.state as { from?: string; investNow?: boolean } | undefined;
    const from =
      parseSafeNextPath(state?.from) ??
      parseSafeNextPath(new URLSearchParams(location.search).get("next")) ??
      parseSafeNextPath(sessionStorage.getItem(AUTH_RETURN_NEXT_KEY));
    sessionStorage.removeItem(AUTH_RETURN_NEXT_KEY);

    const fromOpensMissingDeal =
      from != null && /^\/deals\/[^/?#]+/i.test(from);
    let redirectTo =
      from && !fromOpensMissingDeal
        ? from
        : isPlatformAdmin()
          ? "/metrics"
          : "/dashboard";
    let postAuthState: { investNow: true } | { returnTo: string } | undefined;
    if (portfolioIntent?.dealId) {
      const applied = applyOfferingPortfolioPostAuth(portfolioIntent.dealId);
      redirectTo =
        from && !isPublicOfferingPortfolioReturnPath(from)
          ? from
          : applied.redirectTo;
      postAuthState = applied.postAuthState;
    } else if (!from && storedIntent?.dealId) {
      redirectTo = dealInvestNowPath(storedIntent.dealId);
      postAuthState = { investNow: true as const };
    } else if (state?.investNow === true) {
      postAuthState = { investNow: true as const };
    }
    if (redirectTo === "/") {
      redirectTo = isPlatformAdmin() ? "/metrics" : "/dashboard";
    }
    return { redirectTo, postAuthState };
  }

  async function signInAfterSignup(email: string, password: string): Promise<boolean> {
    const signInUrl = buildApiUrl(apiV1, "auth/signin");
    if (!signInUrl) {
      setIsError("API base URL is invalid. Check VITE_BASE_URL.");
      return false;
    }
    const response = await fetch(signInUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(inviteRef ? { inviteRef } : {}) }),
    });
    const data = (await response.json().catch(() => ({}))) as SigninResponse;
    if (!response.ok) {
      setIsError(
        data.message?.trim() ||
          "Account created, but automatic sign-in failed. Please sign in manually.",
      );
      return false;
    }
    persistSigninSession(data);
    const returnPath =
      parseSafeNextPath(sessionStorage.getItem(AUTH_RETURN_NEXT_KEY)) ??
      parseSafeNextPath(
        (location.state as { from?: string } | null)?.from,
      );
    const pendingPortfolioIntent = resolveOfferingPortfolioClaimIntent(returnPath);
    if (pendingPortfolioIntent?.previewToken || pendingPortfolioIntent?.dealId) {
      try {
        sessionStorage.setItem(SESSION_PORTAL_MODE_KEY, "investing");
      } catch {
        /* sessionStorage unavailable */
      }
    }
    if (pendingPortfolioIntent?.previewToken) {
      try {
        const claimed = await claimOfferingPortfolioAccess(
          pendingPortfolioIntent,
        );
        if (claimed?.userDetails != null) {
          sessionStorage.setItem(
            SESSION_USER_DETAILS_KEY,
            JSON.stringify(claimed.userDetails),
          );
          publishActiveBrowserUserFromSession();
        }
      } catch (claimError) {
        toast.error(
          "Offering access not added",
          claimError instanceof Error
            ? claimError.message
            : "You can still view the public offering.",
        );
      }
    }
    const { redirectTo, postAuthState } = resolvePostAuthPath();
    navigate(redirectTo, { replace: true, state: postAuthState });
    return true;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!apiV1) {
      setIsError("API base URL is not configured (VITE_BASE_URL).");
      return;
    }
    if (isSelfServeSignup && !signUpFormData.signupAs) {
      setIsError("Select whether you are an investor, syndicator, or both.");
      return;
    }
    if (companyRequiredForRole && !signUpFormData.companyName.trim()) {
      setIsError("Company name is required for syndicator accounts.");
      return;
    }
    const phoneE164 = national10ToE164(signUpFormData.phone);
    if (!phoneE164) {
      setIsError(
        "Enter a valid 10-digit U.S. phone number (area code and exchange cannot start with 0 or 1).",
      );
      return;
    }
    setIsLoading(true);
    setIsError("");
    setSuccessNotice("");
    try {
      const submitUrl = token
        ? buildApiUrl(apiV1, `auth/signup/${encodeURIComponent(token)}`)
        : buildApiUrl(apiV1, "auth/signup");
      if (!submitUrl) {
        setIsError("API base URL is invalid. Check VITE_BASE_URL.");
        return;
      }
      const offeringPreviewIntent = isSelfServeSignup
        ? readOfferingPortfolioAuthIntent()
        : null;
      const response = await fetch(submitUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: signUpFormData.email.trim().toLowerCase(),
          companyName:
            signUpFormData.signupAs === "investor"
              ? ""
              : signUpFormData.companyName.trim(),
          ...(isSelfServeSignup ? { signupAs: signUpFormData.signupAs } : {}),
          ...(isSelfServeSignup && inviteRef ? { inviteRef } : {}),
          ...(isSelfServeSignup &&
          signUpFormData.signupAs === "investor" &&
          offeringPreviewIntent?.previewToken
            ? {
                offeringPreviewToken: offeringPreviewIntent.previewToken,
                ...(offeringPreviewIntent.sponsorRef
                  ? {
                      offeringPreviewSponsorRef: offeringPreviewIntent.sponsorRef,
                    }
                  : {}),
              }
            : {}),
          userName: "",
          phone: phoneE164,
          firstName: signUpFormData.firstName.trim(),
          lastName: signUpFormData.lastName.trim(),
          newPassword: signUpFormData.newPassword,
          confirmPassword: signUpFormData.confirmPassword,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        joinedExistingCompany?: boolean;
        companyCreated?: boolean;
      };
      if (!response.ok) {
        setIsError(
          data.message || "Could not create your account. Please try again.",
        );
        return;
      }
      if (data.joinedExistingCompany || data.companyCreated) {
        setSuccessNotice(
          data.message?.trim() ||
            (data.joinedExistingCompany
              ? "This company already exists. Your account was added to that company."
              : "Your company was created and added to the platform."),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
      }
      const email = signUpFormData.email.trim().toLowerCase();
      await signInAfterSignup(email, signUpFormData.newPassword);
    } catch {
      setIsError("Unable to connect. Please try again later.");
    } finally {
      setIsLoading(false);
    }
  }

  if (linkExpired) {
    return (
      <>
        <div
          className="authMessage authMessage--error"
          style={{ marginTop: "0.5em", marginBottom: 0 }}
        >
          <CircleAlert className="authMessage__icon" size={16} aria-hidden />
          <p className="orgError">
            Signup link has expired or is invalid. This link is valid for 7 days
            from when it was sent. Please ask your administrator to resend the
            invite.
          </p>
        </div>
        <p className="forgotPassword" style={{ marginTop: "1em" }}>
          <Link to={LOGIN_PATH}>
            <span>Back to sign in</span>
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="signup_page">
        <div className="signup_modal_content">
          <form
            className="settings_form"
            autoComplete="off"
            onSubmit={handleSubmit}
          >
        <div className="signupForm_rows">
          <div className="signupForm_row">
            <div className="emailData">
              <Input
                labelName="Email"
                id="signup-email"
                icon={<Mail width={20} strokeWidth={1.5} aria-hidden />}
                type="email"
                name="email"
                placeholder="johndoe@domain.com"
                value={signUpFormData.email}
                onChange={handleChange}
                readOnly={Boolean(
                  (token && resolvedInviteEmail) || invitedEmail,
                )}
                disabled={isLoading}
                aria-invalid={!!isError}
                required
              />
            </div>
            {isSelfServeSignup ? (
              <div className="emailData">
                <div className="input_wrapper">
                  <label
                    htmlFor="signup-signupAs"
                    className="input_wrapper__label_row"
                  >
                    <span className="input_wrapper__label_leading">
                      <span className="input_wrapper__label_icon">
                        <Users width={20} strokeWidth={1.5} aria-hidden />
                      </span>
                      <span className="input_wrapper__label_text">
                        Are you an
                      </span>
                    </span>
                    <span
                      className="input_wrapper__required_mark"
                      title="Required"
                      aria-hidden
                    >
                      <Asterisk
                        className="input_wrapper__required_icon"
                        size={14}
                        strokeWidth={2.5}
                        aria-hidden
                      />
                    </span>
                  </label>
                  <select
                    id="signup-signupAs"
                    name="signupAs"
                    className={`input_field signup_as_select${signUpFormData.signupAs ? "" : " signup_as_select--placeholder"}`}
                    value={signUpFormData.signupAs}
                    onChange={(e) =>
                      handleSignupAsChange(e.target.value as SignupAs)
                    }
                    disabled={isLoading}
                    required
                    aria-invalid={!!isError}
                  >
                    <option value="">Select…</option>
                    {SIGNUP_AS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="emailData">
                <Input
                  labelName="Company"
                  id="signup-companyName"
                  icon={<Building2 width={20} strokeWidth={1.5} aria-hidden />}
                  type="text"
                  name="companyName"
                  placeholder="Company name"
                  value={signUpFormData.companyName}
                  onChange={handleChange}
                  readOnly={Boolean(token && resolvedInviteCompanyName)}
                  disabled={isLoading}
                  aria-invalid={!!isError}
                  requiredIndicator={false}
                />
              </div>
            )}
          </div>

          {isSelfServeSignup ? (
            <div className="signupForm_row">
              <div className="emailData">
                <Input
                  labelName="Company"
                  id="signup-companyName"
                  icon={<Building2 width={20} strokeWidth={1.5} aria-hidden />}
                  type="text"
                  name="companyName"
                  placeholder={
                    !signUpFormData.signupAs
                      ? "Select how you are signing up"
                      : companyDisabledForInvestor
                        ? "Add your company later in My account"
                        : "Your company name"
                  }
                  value={signUpFormData.companyName}
                  onChange={handleChange}
                  disabled={isLoading || !companyFieldEnabled}
                  aria-invalid={!!isError}
                  required={companyRequiredForRole}
                  requiredIndicator={companyRequiredForRole}
                  optionalIndicator={!companyRequiredForRole}
                />
              </div>
              <div className="emailData">
                <div className="input_wrapper">
                  <label
                    htmlFor="signup-phone"
                    className="input_wrapper__label_row"
                  >
                    <span className="input_wrapper__label_leading">
                      <span className="input_wrapper__label_icon">
                        <Phone width={20} strokeWidth={1.5} aria-hidden />
                      </span>
                      <span className="input_wrapper__label_text">
                        Phone number
                      </span>
                    </span>
                    <span
                      className="input_wrapper__required_mark"
                      title="Required"
                      aria-hidden
                    >
                      <Asterisk
                        className="input_wrapper__required_icon"
                        size={14}
                        strokeWidth={2.5}
                        aria-hidden
                      />
                    </span>
                  </label>
                  <UsPhoneInput
                    id="signup-phone"
                    name="phone"
                    placeholder="(555) 123-4567"
                    nationalDigits={signUpFormData.phone}
                    onNationalDigitsChange={(digits) => {
                      setSignUpFormData((prev) => ({ ...prev, phone: digits }));
                      if (isError) setIsError("");
                    }}
                    readOnly={lockedPrefill.phone}
                    disabled={isLoading}
                    className="input_field"
                    aria-invalid={!!isError}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="signupForm_row">
              <div className="emailData">
                <div className="input_wrapper">
                  <label
                    htmlFor="signup-phone"
                    className="input_wrapper__label_row"
                  >
                    <span className="input_wrapper__label_leading">
                      <span className="input_wrapper__label_icon">
                        <Phone width={20} strokeWidth={1.5} aria-hidden />
                      </span>
                      <span className="input_wrapper__label_text">
                        Phone number
                      </span>
                    </span>
                    <span
                      className="input_wrapper__required_mark"
                      title="Required"
                      aria-hidden
                    >
                      <Asterisk
                        className="input_wrapper__required_icon"
                        size={14}
                        strokeWidth={2.5}
                        aria-hidden
                      />
                    </span>
                  </label>
                  <UsPhoneInput
                    id="signup-phone"
                    name="phone"
                    placeholder="(555) 123-4567"
                    nationalDigits={signUpFormData.phone}
                    onNationalDigitsChange={(digits) => {
                      setSignUpFormData((prev) => ({ ...prev, phone: digits }));
                      if (isError) setIsError("");
                    }}
                    readOnly={lockedPrefill.phone}
                    disabled={isLoading}
                    className="input_field"
                    aria-invalid={!!isError}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="signupForm_row">
            <div className="emailData">
              <Input
                labelName="First name"
                id="signup-firstName"
                icon={<User width={20} strokeWidth={1.5} aria-hidden />}
                type="text"
                name="firstName"
                placeholder="John"
                value={signUpFormData.firstName}
                onChange={handleChange}
                readOnly={lockedPrefill.firstName}
                disabled={isLoading}
                aria-invalid={!!isError}
                required
              />
            </div>
            <div className="emailData">
              <Input
                labelName="Last name"
                id="signup-lastName"
                icon={<User width={20} strokeWidth={1.5} aria-hidden />}
                type="text"
                name="lastName"
                placeholder="Doe"
                value={signUpFormData.lastName}
                onChange={handleChange}
                readOnly={lockedPrefill.lastName}
                disabled={isLoading}
                aria-invalid={!!isError}
                required
              />
            </div>
          </div>

          <div className="signupForm_row">
            <div className="passwordData">
              <Input
                labelName="New password"
                id="signup-newPassword"
                icon={<LockKeyhole width={20} strokeWidth={1.5} aria-hidden />}
                type={isVisible ? "text" : "password"}
                name="newPassword"
                value={signUpFormData.newPassword}
                onChange={handleChange}
                placeholder="......."
                maxLength={16}
                disabled={isLoading}
                aria-invalid={!!isError}
                required
                suffix={
                  <span
                    onClick={passwordVisible}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        passwordVisible();
                      }
                    }}
                    className="passwordVisible"
                    role="button"
                    tabIndex={0}
                    aria-label={isVisible ? "Hide password" : "Show password"}
                  >
                    {isVisible ? (
                      <Eye size={20} strokeWidth={1.5} aria-hidden />
                    ) : (
                      <EyeOff size={20} strokeWidth={1.5} aria-hidden />
                    )}
                  </span>
                }
              />
            </div>
            <div className="passwordData">
              <Input
                labelName="Confirm password"
                id="signup-confirmPassword"
                icon={<LockKeyhole width={20} strokeWidth={1.5} aria-hidden />}
                type={isVisibleConfirm ? "text" : "password"}
                name="confirmPassword"
                value={signUpFormData.confirmPassword}
                onChange={handleChange}
                placeholder="......."
                maxLength={16}
                disabled={isLoading}
                aria-invalid={!!isError}
                required
                suffix={
                  <span
                    onClick={confirmPasswordVisible}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        confirmPasswordVisible();
                      }
                    }}
                    className="passwordVisible"
                    role="button"
                    tabIndex={0}
                    aria-label={
                      isVisibleConfirm ? "Hide password" : "Show password"
                    }
                  >
                    {isVisibleConfirm ? (
                      <Eye size={20} strokeWidth={1.5} aria-hidden />
                    ) : (
                      <EyeOff size={20} strokeWidth={1.5} aria-hidden />
                    )}
                  </span>
                }
              />
            </div>
          </div>
        </div>

        <div className="terms_policy">
          <input
            type="checkbox"
            id="termsandpolicy"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            disabled={isLoading}
            aria-required
          />
          <label htmlFor="termsandpolicy" className="signup_terms_label_row">
            <span className="signup_terms_label_text">
              I agree to the{" "}
              <Link to="/termsandservices" className="terms">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link className="policy" to="/privacypolicy">
                Privacy Policy
              </Link>
              <span
                className="signup_terms_required_mark"
                title="Required"
                aria-hidden
              >
                {/* <Asterisk
                  size={14}
                  strokeWidth={2.5}
                  className="signup_terms_required_icon"
                  aria-hidden
                /> */}
              </span>
            </span>
          </label>
        </div>

        {successNotice ? (
          <div
            className="authMessage authMessage--success"
            style={{ marginTop: "0.5em", marginBottom: 0 }}
          >
            <CircleCheck className="authMessage__icon" size={16} aria-hidden />
            <p>{successNotice}</p>
          </div>
        ) : null}

        {isError ? (
          <div
            className="authMessage authMessage--error"
            style={{ marginTop: "0.5em", marginBottom: 0 }}
          >
            <CircleAlert className="authMessage__icon" size={16} aria-hidden />
            <p className="orgError">{isError}</p>
          </div>
        ) : null}

        <div className="loginBtn">
          <button
            type="submit"
            className={`login-btn ${isDisabledBtn ? "disabled_css" : ""} ${isLoading ? "auth_btn_loading" : ""}`}
            disabled={isDisabledBtn}
            aria-busy={isLoading}
          >
            {isLoading ? (
              <Loader2 className="auth_spinner" size={20} aria-hidden />
            ) : (
              <>
                Create account <ArrowRight width={20} aria-hidden />
              </>
            )}
          </button>
        </div>
        <p className="auth_footer_links">
          Already have an account?{" "}
          <Link
            to={
              inviteRef || searchParams.get("next")
                ? `/signin?${new URLSearchParams({
                    ...(inviteRef ? { ref: inviteRef } : {}),
                    ...(inviteSponsorName
                      ? { sponsorName: inviteSponsorName }
                      : {}),
                    ...(inviteCompanyName
                      ? { companyName: inviteCompanyName }
                      : {}),
                    ...(searchParams.get("next")?.trim()
                      ? { next: searchParams.get("next")!.trim() }
                      : {}),
                    ...(signUpFormData.email.trim()
                      ? { email: signUpFormData.email.trim().toLowerCase() }
                      : {}),
                  }).toString()}`
                : signUpFormData.email.trim()
                  ? `/signin?${new URLSearchParams({
                      email: signUpFormData.email.trim().toLowerCase(),
                    }).toString()}`
                : "/signin"
            }
          >
            Sign in
          </Link>
        </p>

        <div className="auth_help companyContent">
          <FooterForm />
        </div>
          </form>
        </div>
      </div>
    </>
  );
}

interface SignUpFormState {
  email: string;
  companyName: string;
  signupAs: SignupAs;
  userName: string;
  firstName: string;
  lastName: string;
  phone: string;
  newPassword: string;
  confirmPassword: string;
}
