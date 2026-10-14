import type { AddDealFormRow } from "../../schema/deal.schema/add-deal-form.schema.js";
import type { DealInvestorClassRow } from "../../schema/deal.schema/deal-investor-class.schema.js";
import {
  sumCommittedAmountByDealIds,
  sumCommittedAmountForDeal,
} from "./dealInvestment.service.js";
import {
  listInvestorClassesByDealId,
  mapInvestorClassesByDealIds,
} from "./dealInvestorClass.service.js";

function parseMoneyDigits(raw: string): number {
  const n = Number.parseFloat(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatUsdNonZero(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export type EnrichedDealListRowFields = {
  raiseTarget: string;
  totalAccepted: string;
  totalInProgress: string;
  investmentType: string;
  propertyType: string;
};

/**
 * Fills deals-list KPI columns and investor-class-derived labels for dashboard cards.
 * Offering size = sum of investor-class offering sizes (else $0).
 * Total accepted = sum of investment commitment amounts.
 * Total in-progress = max(0, offering total − accepted) as remaining raise.
 */
function enrichedFieldsFrom(
  classes: readonly DealInvestorClassRow[],
  sumCommitted: number,
): EnrichedDealListRowFields {
  let sumOffering = 0;
  for (const c of classes) {
    sumOffering += parseMoneyDigits(String(c.offeringSize ?? ""));
  }

  const remaining = Math.max(0, sumOffering - sumCommitted);

  let investmentType = "";
  let propertyType = "";
  if (classes.length > 0) {
    try {
      const raw = JSON.parse(classes[0]!.advancedOptionsJson || "{}") as Record<
        string,
        unknown
      >;
      if (typeof raw.investmentType === "string" && raw.investmentType.trim()) {
        investmentType = raw.investmentType.trim();
      }
      const tags = Array.isArray(raw.assetTags)
        ? raw.assetTags.filter((x): x is string => typeof x === "string")
        : [];
      if (tags.length > 0 && tags[0]!.trim()) propertyType = tags[0]!.trim();
    } catch {
      /* ignore malformed JSON */
    }
  }

  return {
    raiseTarget: sumOffering > 0 ? formatUsdNonZero(sumOffering) : "$0",
    totalAccepted: sumCommitted > 0 ? formatUsdNonZero(sumCommitted) : "$0",
    totalInProgress: formatUsdNonZero(remaining),
    investmentType: investmentType || "—",
    propertyType: propertyType || "—",
  };
}

export async function enrichDealListRowForApi(
  row: AddDealFormRow,
): Promise<EnrichedDealListRowFields> {
  const dealId = String(row.id);
  const [classes, sumCommitted] = await Promise.all([
    listInvestorClassesByDealId(dealId),
    sumCommittedAmountForDeal(dealId),
  ]);
  return enrichedFieldsFrom(classes, sumCommitted);
}

/**
 * Same fields as `enrichDealListRowForApi` for a whole list, using two queries instead of
 * two per deal. The deals list previously issued 2N queries here, so its response time grew
 * linearly with the number of deals in the workspace.
 */
export async function mapDealListEnrichmentByDealId(
  rows: readonly AddDealFormRow[],
): Promise<Map<string, EnrichedDealListRowFields>> {
  const byDealId = new Map<string, EnrichedDealListRowFields>();
  const dealIds = rows.map((r) => String(r.id));
  if (dealIds.length === 0) return byDealId;

  const [classesByDealId, committedByDealId] = await Promise.all([
    mapInvestorClassesByDealIds(dealIds),
    sumCommittedAmountByDealIds(dealIds),
  ]);

  for (const dealId of dealIds) {
    byDealId.set(
      dealId,
      enrichedFieldsFrom(
        classesByDealId.get(dealId) ?? [],
        committedByDealId.get(dealId) ?? 0,
      ),
    );
  }
  return byDealId;
}
