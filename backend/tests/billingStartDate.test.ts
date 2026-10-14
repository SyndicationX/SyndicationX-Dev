import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  utcMidnightFromYmdString,
  utcMidnightToday,
} from "../src/services/billing/saasBillingStartDate.js";

process.env.JWT_SECRET_KEY =
  process.env.JWT_SECRET_KEY ??
  "test-jwt-secret-key-at-least-32-chars-long!!";

describe("billing start date", () => {
  it("rejects calendar days before today UTC", () => {
    const today = utcMidnightToday();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const ymd = yesterday.toISOString().slice(0, 10);
    const parsed = utcMidnightFromYmdString(ymd);
    assert.ok(parsed);
    assert.equal(parsed.getTime() < today.getTime(), true);
  });

  it("allows today UTC", () => {
    const today = utcMidnightToday();
    const ymd = today.toISOString().slice(0, 10);
    const parsed = utcMidnightFromYmdString(ymd);
    assert.ok(parsed);
    assert.equal(parsed.getTime() < today.getTime(), false);
  });
});
