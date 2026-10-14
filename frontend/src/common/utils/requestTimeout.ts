/**
 * Per-request time budgets for portal API calls.
 *
 * Data loads (GET/HEAD) run without a budget — a slow list is better than one
 * that aborts itself. Mutations and uploads keep a budget because aborting a
 * payment, e-sign send, or file upload mid-flight loses work.
 *
 * Any call can still opt into a budget with {@link PORTAL_TIMEOUT_HEADER}.
 */

/** Write budget (POST/PUT/PATCH/DELETE) — Stripe, e-sign, and mail calls need headroom. */
export const MUTATION_TIMEOUT_MS = 30_000;
/** Multipart/binary body budget — offering documents and branding assets are large. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Per-call override in milliseconds; `0` disables the budget for that request.
 * Stripped before the request leaves the browser.
 */
export const PORTAL_TIMEOUT_HEADER = "x-portal-timeout-ms";

export class RequestTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(
      `This is taking longer than ${Math.round(
        timeoutMs / 1000,
      )}s to load. Please check your connection and try again.`,
    );
    this.name = "RequestTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export function isRequestTimeoutError(err: unknown): err is RequestTimeoutError {
  return err instanceof RequestTimeoutError;
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = init?.method?.trim();
  if (fromInit) return fromInit.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function isBinaryBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return false;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return true;
  }
  return body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/** Override from `PORTAL_TIMEOUT_HEADER`, or `null` when the caller did not set one. */
function readTimeoutOverride(
  input: RequestInfo | URL,
  init?: RequestInit,
): number | null {
  const fromInit = new Headers(init?.headers).get(PORTAL_TIMEOUT_HEADER);
  const fromRequest =
    fromInit == null && typeof Request !== "undefined" && input instanceof Request
      ? input.headers.get(PORTAL_TIMEOUT_HEADER)
      : null;
  const raw = (fromInit ?? fromRequest)?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveRequestTimeoutMs(
  input: RequestInfo | URL,
  init?: RequestInit,
): number {
  const override = readTimeoutOverride(input, init);
  if (override != null) return override;
  if (isBinaryBody(init?.body)) return UPLOAD_TIMEOUT_MS;
  const method = resolveMethod(input, init);
  /** `0` means no budget: reads are never aborted for taking too long. */
  if (method === "GET" || method === "HEAD") return 0;
  return MUTATION_TIMEOUT_MS;
}

/**
 * Runs `send` under `timeoutMs`, aborting the in-flight request when the budget is spent.
 * A caller-supplied `external` signal still aborts normally and surfaces its own reason.
 */
export async function withRequestTimeout<T>(
  url: string,
  timeoutMs: number,
  external: AbortSignal | null | undefined,
  send: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return send(external ?? undefined);
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await send(controller.signal);
  } catch (err) {
    if (timedOut && !external?.aborted) throw new RequestTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abortFromExternal);
  }
}
