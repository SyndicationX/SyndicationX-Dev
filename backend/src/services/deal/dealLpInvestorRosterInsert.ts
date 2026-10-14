import { db } from "../../database/db.js";
import {
  dealLpInvestor,
  type DealLpInvestorInsert,
} from "../../schema/deal.schema/deal-lp-investor.schema.js";

function postgresErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const cause =
    "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause) {
    return String((cause as { code?: unknown }).code ?? "");
  }
  if ("code" in err) return String((err as { code?: unknown }).code ?? "");
  return "";
}

/**
 * Insert an LP roster row. Duplicate roster keys are ignored.
 * The live unique key is `(deal_id, contact_member_id, investor_class, source_profile_id)`,
 * which does not match an `ON CONFLICT (deal_id, contact_member_id)` clause, so that
 * clause aborts the insert before the row is written.
 */
export async function insertDealLpInvestorRosterRow(
  values: DealLpInvestorInsert,
): Promise<void> {
  try {
    await db.insert(dealLpInvestor).values(values);
  } catch (err) {
    if (postgresErrorCode(err) === "23505") return;
    throw err;
  }
}
