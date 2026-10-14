/**
 * Latency budget tracking for /api/v1.
 *
 * The SPA aborts data loads after 3s, so any read slower than that is a broken screen for
 * the user even though the server eventually answers. This middleware records those misses
 * (and client aborts, which never reach `finish`) so slow endpoints can be found and tuned.
 *
 * Mount before the routers; it only observes and never fails a request.
 */

import type { NextFunction, Request, Response } from "express";
import { requestPathOnly } from "../audit/index.js";
import { performanceLogger } from "../logging/performance.logger.js";

function envBudgetMs(name: string, fallbackMs: number): number {
  const parsed = Number(process.env[name]?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

/** Must match DATA_LOAD_TIMEOUT_MS in frontend/src/common/utils/requestTimeout.ts. */
export const READ_BUDGET_MS = envBudgetMs("API_READ_BUDGET_MS", 3_000);
export const WRITE_BUDGET_MS = envBudgetMs("API_WRITE_BUDGET_MS", 30_000);

function budgetForMethod(method: string): number {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" ? READ_BUDGET_MS : WRITE_BUDGET_MS;
}

export function requestBudgetMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startedAt = process.hrtime.bigint();
  const budgetMs = budgetForMethod(req.method);
  let reported = false;

  const report = (aborted: boolean): void => {
    if (reported) return;
    reported = true;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (!aborted && durationMs <= budgetMs) return;

    /**
     * An abort inside the budget is the browser cancelling (navigation, unmount,
     * StrictMode double-effect) — not a latency problem, so it stays below warn.
     * Aborts past the budget are the SPA's own timeout firing and do matter.
     */
    const overBudget = durationMs > budgetMs;
    const log = overBudget
      ? performanceLogger.warn.bind(performanceLogger)
      : performanceLogger.debug.bind(performanceLogger);

    log({
      message: !overBudget
        ? "Client cancelled the request (within budget)"
        : aborted
          ? "Client aborted after the latency budget was exceeded"
          : "Request exceeded its latency budget",
      module: "http_performance",
      aborted,
      method: req.method,
      path: requestPathOnly(req),
      route: req.route?.path ?? undefined,
      httpStatus: res.statusCode,
      durationMs: Math.round(durationMs),
      budgetMs,
      overBudgetMs: Math.max(0, Math.round(durationMs - budgetMs)),
    });
  };

  res.on("finish", () => report(false));
  res.on("close", () => report(!res.writableEnded));

  next();
}
