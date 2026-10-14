import React from "react";
import FooterForm from "../../../common/components/FooterForm";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle,
  CircleAlert,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  Mail,
} from "lucide-react";
import { useEffect, useState } from "react";
import Input from "../../../common/components/Input";
import {
  AUTH_RETURN_NEXT_KEY,
  SESSION_ACTIVITY_SESSION_ID_KEY,
  SESSION_BEARER_KEY,
  SESSION_PORTAL_MODE_KEY,
  SESSION_REFRESH_KEY,
  SESSION_USER_DETAILS_KEY,
} from "../../../common/auth/sessionKeys";
import { storeAuthTokens } from "../../../common/auth/authTokensApi";
import { publishActiveBrowserUserFromSession } from "../../../common/auth/exclusiveBrowserSession";
import {
  touchSessionActivity,
} from "../../../common/auth/idleSession";
import { INVESTOR, isPlatformAdmin } from "../../../common/auth/roleUtils";
import { getApiV1Base } from "../../../common/utils/apiBaseUrl";
import { dealInvestNowPath } from "../../Syndication/Deals/utils/dealInvestNowPath";
import { consumeInvestNowIntent } from "../../Syndication/Deals/utils/investNowIntent";
import {
  applyOfferingPortfolioPostAuth,
  claimOfferingPortfolioAccess,
  consumeOfferingPortfolioAuthIntent,
  isPublicOfferingPortfolioReturnPath,
  resolveOfferingPortfolioClaimIntent,
} from "../../Syndication/Deals/utils/offeringPortfolioAuthIntent";
import { parseSafeNextPath } from "../../../common/auth/parseSafeNextPath";
import { toast } from "../../../common/components/Toast";
import { ensureActiveCompanyInitialized } from "../../../common/auth/setActiveCompany";
import "./signin_form.css";

/** Platform admins open Platform Metrics; every other role opens the Dashboard. */
function homePathAfterSignIn(): string {
  return isPlatformAdmin() ? "/metrics" : "/dashboard";
}

/** Deal, invest-now, and eSign links should reopen that page after sign-in. */
function isLinkedSignInReturn(path: string | null): boolean {
  if (!path) return false;
  if (/\/esign(?:\/|$|\?)/i.test(path)) return true;
  return /^\/deals\/[^/?#]+/i.test(path);
}

/** Investor accounts stay `investor` after a sponsor roster add; open Syndicating on sign-in. */
function openSyndicatingForInvestorSponsor(userDetails: unknown): void {
  const first = Array.isArray(userDetails) ? userDetails[0] : null;
  if (!first || typeof first !== "object") return;
  const row = first as Record<string, unknown>;
  if (String(row.role ?? "").trim() !== INVESTOR) return;
  if (row.is_deal_sponsor !== true) return;
  try {
    sessionStorage.setItem(SESSION_PORTAL_MODE_KEY, "syndicating");
  } catch {
    /* sessionStorage unavailable */
  }
}

const SigninForm = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const resetSuccess = location.state?.resetSuccess;
  const apiV1 = getApiV1Base();
  const inviteRef = searchParams.get("ref")?.trim() || "";
  const inviteSponsorName = searchParams.get("sponsorName")?.trim() || "";
  const inviteCompanyName = searchParams.get("companyName")?.trim() || "";
  const routeState = location.state as
    | {
        from?: string;
        investNow?: boolean;
        email?: string;
        resetSuccess?: boolean;
      }
    | undefined;
  const emailPrefill = (
    searchParams.get("email") ??
    routeState?.email ??
    ""
  )
    .trim()
    .toLowerCase();

  const [email, setEmail] = useState(emailPrefill);
  const [password, setPassword] = useState("");
  const [isVisible, setIsVisible] = useState(false);
  const [isError, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const passwordVisible = () => setIsVisible((prev) => !prev);

  useEffect(() => {
    if (!emailPrefill) return;
    setEmail((prev) => (prev.trim() ? prev : emailPrefill));
  }, [emailPrefill]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!apiV1) {
      setError("API base URL is not configured (VITE_BASE_URL).");
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiV1}/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          ...(inviteRef ? { inviteRef } : {}),
        }),
      });
      const rawBody = await response.text().catch(() => "");
      let data: {
        message?: string;
        token?: string;
        accessToken?: string;
        refreshToken?: string;
        userDetails?: unknown;
        activitySessionId?: string;
      } = {};
      if (rawBody.trim()) {
        try {
          data = JSON.parse(rawBody) as typeof data;
        } catch {
          data = {};
        }
      }

      if (!response.ok) {
        if (response.status === 502 || response.status === 503) {
          setError(
            "Cannot reach the API. Start the backend (npm run dev in the backend folder) and ensure BACKEND_PORT in backend/.env.local matches the Vite proxy (default 5004).",
          );
          return;
        }
        const msg =
          data.message?.trim() ||
          (rawBody.trim() && !rawBody.trim().startsWith("{")
            ? rawBody.trim().slice(0, 240)
            : "") ||
          "Sign in failed. Please try again.";
        if (response.status === 403) {
          setError(
            data.message ||
              "Sign in forbidden (403). Check that the backend is running and Vite’s `/api` proxy target matches BACKEND_PORT (set VITE_DEV_API_PROXY if needed).",
          );
          return;
        }
        setError(msg);
        if (/user not found/i.test(msg)) {
          toast.error(
            "User not found",
            "No account matches that email. Check your details or sign up.",
          );
        }
        return;
      }
      const accessToken =
        typeof data.accessToken === "string"
          ? data.accessToken
          : typeof data.token === "string"
            ? data.token
            : null;
      if (accessToken) {
        storeAuthTokens(accessToken, data.refreshToken ?? null);
        touchSessionActivity();
      } else {
        sessionStorage.removeItem(SESSION_BEARER_KEY);
        sessionStorage.removeItem(SESSION_REFRESH_KEY);
      }
      if (data.userDetails != null) {
        sessionStorage.setItem(
          SESSION_USER_DETAILS_KEY,
          JSON.stringify(data.userDetails),
        );
        ensureActiveCompanyInitialized();
        publishActiveBrowserUserFromSession();
      } else {
        sessionStorage.removeItem(SESSION_USER_DETAILS_KEY);
      }
      if (typeof data.activitySessionId === "string" && data.activitySessionId.trim()) {
        sessionStorage.setItem(
          SESSION_ACTIVITY_SESSION_ID_KEY,
          data.activitySessionId.trim(),
        );
      } else {
        sessionStorage.removeItem(SESSION_ACTIVITY_SESSION_ID_KEY);
      }
      const from =
        parseSafeNextPath(routeState?.from) ??
        parseSafeNextPath(new URLSearchParams(location.search).get("next")) ??
        parseSafeNextPath(sessionStorage.getItem(AUTH_RETURN_NEXT_KEY));
      const pendingPortfolioIntent = resolveOfferingPortfolioClaimIntent(from);
      if (pendingPortfolioIntent?.previewToken || pendingPortfolioIntent?.dealId) {
        try {
          sessionStorage.setItem(SESSION_PORTAL_MODE_KEY, "investing");
        } catch {
          /* sessionStorage unavailable */
        }
      } else if (data.userDetails != null) {
        openSyndicatingForInvestorSponsor(data.userDetails);
      }
      let claimedDealId = "";
      if (pendingPortfolioIntent?.previewToken) {
        try {
          const claimed = await claimOfferingPortfolioAccess(
            pendingPortfolioIntent,
          );
          claimedDealId = String(claimed?.dealId ?? "").trim();
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
      const portfolioIntent = consumeOfferingPortfolioAuthIntent();
      const storedIntent = consumeInvestNowIntent();
      sessionStorage.removeItem(AUTH_RETURN_NEXT_KEY);
      let redirectTo = from ? from : homePathAfterSignIn();
      let postSignInState:
        | { investNow: true }
        | { returnTo: string }
        | undefined;
      const offeringDealId =
        portfolioIntent?.dealId ||
        (claimedDealId && claimedDealId !== "preview" ? claimedDealId : "");
      if (offeringDealId) {
        const applied = applyOfferingPortfolioPostAuth(offeringDealId);
        redirectTo =
          from && !isPublicOfferingPortfolioReturnPath(from)
            ? from
            : applied.redirectTo;
        postSignInState = applied.postAuthState;
      } else if (!from && storedIntent?.dealId) {
        redirectTo = dealInvestNowPath(storedIntent.dealId);
        postSignInState = { investNow: true as const };
      } else if (routeState?.investNow === true) {
        postSignInState = { investNow: true as const };
      }
      if (redirectTo === "/") {
        redirectTo = homePathAfterSignIn();
      }
      const continuingLinkedFlow =
        Boolean(offeringDealId) ||
        Boolean(storedIntent?.dealId) ||
        routeState?.investNow === true ||
        isLinkedSignInReturn(from);
      if (!isPlatformAdmin() && !continuingLinkedFlow) {
        redirectTo = "/dashboard";
      }
      navigate(redirectTo, { replace: true, state: postSignInState });
    } catch {
      setError(
        "Unable to connect to the API. Start the backend with npm run dev in the backend folder (port 5004 by default), then refresh this page.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  const isDisabledBtn = !email.trim() || !password.trim() || isLoading;

  const pendingEsignReturn =
    parseSafeNextPath(new URLSearchParams(location.search).get("next"))?.includes(
      "/esign",
    ) ?? false;

  return (
    <>
      {pendingEsignReturn ? (
        <p className="authMessage" role="status">
          Sign in with the email that received the eSign request. After sign-in you
          will be taken to the document signing page.
        </p>
      ) : null}
      {/* Session timeout card — toast at top center is used instead.
      {showSessionTimeoutCard ? (
        <div className="auth_session_card" role="status" aria-live="polite">
          <TriangleAlert
            className="auth_session_card_icon"
            size={15}
            strokeWidth={2}
            aria-hidden
          />
          <p className="auth_session_card_text">
            <span className="auth_session_card_label">Session timed out.</span>{" "}
            You were signed out after 15 minutes of inactivity. Sign in again to
            continue.
          </p>
        </div>
      ) : null}
      */}
      <form autoComplete="off" onSubmit={handleSubmit}>
        <div className="emailData">
          <Input
            labelName="Email"
            id="loginEmail"
            icon={<Mail width={20} strokeWidth={1.5} aria-hidden />}
            type="email"
            name="email"
            placeholder="johndoe@domain.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (isError) setError("");
            }}
            aria-invalid={!!isError}
            required
            requiredIndicator={false}
            disabled={isLoading}
          />
        </div>

        <div className="passwordData">
          <Input
            labelName="Password"
            id="loginPassword"
            icon={<LockKeyhole width={20} strokeWidth={1.5} aria-hidden />}
            type={isVisible ? "text" : "password"}
            name="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (isError) setError("");
            }}
            placeholder="......."
            aria-invalid={!!isError}
            required
            requiredIndicator={false}
            disabled={isLoading}
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

        <p className="auth_row_forgot">
          <Link to="/forgotPassword" className="auth_link">
            Forgot password?
          </Link>
        </p>

        {resetSuccess && (
          <div className="authMessage authMessage--success">
            <CheckCircle className="authMessage__icon" size={16} aria-hidden />
            <p className="authMessage__text">
              Password reset successfully. You can sign in with your new
              password.
            </p>
          </div>
        )}
        {isError && (
          <div className="authMessage authMessage--error">
            <CircleAlert className="authMessage__icon" size={16} aria-hidden />
            <p className="authMessage__text">{isError}</p>
          </div>
        )}

        <div className="loginBtn">
          <button
            type="submit"
            className={`login-btn ${isDisabledBtn ? "disabled_css" : ""} ${isLoading ? "auth_btn_loading" : ""}`}
            disabled={isDisabledBtn}
            aria-busy={isLoading}
          >
            {isLoading ? (
              <>
                Signing in…
                <Loader2 className="auth_spinner" size={20} aria-hidden />
              </>
            ) : (
              <>
                Sign in <ArrowRight width={20} />
              </>
            )}
          </button>
        </div>

        <p className="auth_footer_links">
          Don&apos;t have an account?{" "}
          <Link
            to={
              inviteRef || searchParams.get("next")
                ? `/signup?${new URLSearchParams({
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
                  }).toString()}`
                : "/signup"
            }
            state={location.state}
          >
            Sign up
          </Link>
        </p>

        <div className="auth_help companyContent">
          {/* <p>
            Use the email and password provided by your sponsor or
            administrator. Need help? Contact your deal team or reset your
            password above.
          </p> */}
          <FooterForm />
        </div>
      </form>
    </>
  );
};

export default SigninForm;
