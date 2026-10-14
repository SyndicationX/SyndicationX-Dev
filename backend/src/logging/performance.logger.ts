/**
 * Performance channel (Pino → stdout) for requests that miss their latency budget.
 *
 * Separate from the SOC audit file so ops can tail slow endpoints without parsing
 * the audit log, and so raising log volume here never affects the audit trail.
 *
 * Configuration: PERF_LOG_LEVEL (falls back to LOG_LEVEL), LOG_SERVICE_NAME, APP_VERSION.
 */

import pino from "pino";
import { createStructuredPinoLogger } from "./structured-pino.factory.js";

const rootStructured = createStructuredPinoLogger({
  destination: pino.destination({ fd: 1, sync: false }),
  level: process.env.PERF_LOG_LEVEL?.trim() ?? process.env.LOG_LEVEL?.trim() ?? "info",
});

export const performanceLogger = rootStructured.child({ channel: "performance" });
