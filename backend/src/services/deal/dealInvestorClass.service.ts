import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../database/db.js";
import {
  dealInvestorClass,
  type DealInvestorClassInsert,
  type DealInvestorClassRow,
} from "../../schema/deal.schema/deal-investor-class.schema.js";
import { scheduleDealSaasBillingSync } from "../billing/dealBilling.service.js";

export type InvestorClassInput = {
  name: string;
  subscriptionType: string;
  entityName: string;
  startDate: string;
  offeringSize: string;
  raiseAmountDistributions: string;
  billingRaiseQuota: string;
  minimumInvestment: string;
  numberOfUnits: string;
  pricePerUnit: string;
  status: string;
  visibility: string;
  advancedOptionsJson: string;
};

export function mapRowToJson(row: DealInvestorClassRow) {
  return {
    id: row.id,
    dealId: row.dealId,
    name: row.name,
    subscriptionType: row.subscriptionType,
    entityName: row.entityName,
    startDate: row.startDate,
    offeringSize: row.offeringSize,
    raiseAmountDistributions: row.raiseAmountDistributions,
    billingRaiseQuota: row.billingRaiseQuota,
    minimumInvestment: row.minimumInvestment,
    numberOfUnits: row.numberOfUnits,
    pricePerUnit: row.pricePerUnit,
    status: row.status,
    visibility: row.visibility,
    advancedOptionsJson: row.advancedOptionsJson,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}

export async function listInvestorClassesByDealId(
  dealId: string,
): Promise<DealInvestorClassRow[]> {
  return db
    .select()
    .from(dealInvestorClass)
    .where(eq(dealInvestorClass.dealId, dealId))
    .orderBy(asc(dealInvestorClass.createdAt));
}

/**
 * `listInvestorClassesByDealId` for many deals in one query — the deals list needs classes
 * for every row, and querying per row made load time scale with the number of deals.
 */
export async function mapInvestorClassesByDealIds(
  dealIds: readonly string[],
): Promise<Map<string, DealInvestorClassRow[]>> {
  const byDealId = new Map<string, DealInvestorClassRow[]>();
  const ids = [
    ...new Set(dealIds.map((d) => String(d ?? "").trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return byDealId;

  const rows = await db
    .select()
    .from(dealInvestorClass)
    .where(inArray(dealInvestorClass.dealId, ids))
    .orderBy(asc(dealInvestorClass.createdAt));

  for (const row of rows) {
    const key = String(row.dealId);
    const existing = byDealId.get(key);
    if (existing) existing.push(row);
    else byDealId.set(key, [row]);
  }
  return byDealId;
}

export async function insertInvestorClass(params: {
  dealId: string;
  input: InvestorClassInput;
}): Promise<DealInvestorClassRow> {
  const row: DealInvestorClassInsert = {
    dealId: params.dealId,
    name: params.input.name,
    subscriptionType: params.input.subscriptionType,
    entityName: params.input.entityName,
    startDate: params.input.startDate,
    offeringSize: params.input.offeringSize,
    raiseAmountDistributions: params.input.raiseAmountDistributions,
    billingRaiseQuota: params.input.billingRaiseQuota,
    minimumInvestment: params.input.minimumInvestment,
    numberOfUnits: params.input.numberOfUnits,
    pricePerUnit: params.input.pricePerUnit,
    status: params.input.status,
    visibility: params.input.visibility,
    advancedOptionsJson: params.input.advancedOptionsJson,
  };
  const [inserted] = await db.insert(dealInvestorClass).values(row).returning();
  if (!inserted) throw new Error("INSERT_INVESTOR_CLASS_FAILED");
  scheduleDealSaasBillingSync(params.dealId);
  return inserted;
}

export async function updateInvestorClass(params: {
  dealId: string;
  classId: string;
  input: InvestorClassInput;
}): Promise<DealInvestorClassRow | null> {
  const [updated] = await db
    .update(dealInvestorClass)
    .set({
      name: params.input.name,
      subscriptionType: params.input.subscriptionType,
      entityName: params.input.entityName,
      startDate: params.input.startDate,
      offeringSize: params.input.offeringSize,
      raiseAmountDistributions: params.input.raiseAmountDistributions,
      billingRaiseQuota: params.input.billingRaiseQuota,
      minimumInvestment: params.input.minimumInvestment,
      numberOfUnits: params.input.numberOfUnits,
      pricePerUnit: params.input.pricePerUnit,
      status: params.input.status,
      visibility: params.input.visibility,
      advancedOptionsJson: params.input.advancedOptionsJson,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dealInvestorClass.id, params.classId),
        eq(dealInvestorClass.dealId, params.dealId),
      ),
    )
    .returning();
  if (updated) scheduleDealSaasBillingSync(params.dealId);
  return updated ?? null;
}

export async function deleteInvestorClass(params: {
  dealId: string;
  classId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(dealInvestorClass)
    .where(
      and(
        eq(dealInvestorClass.id, params.classId),
        eq(dealInvestorClass.dealId, params.dealId),
      ),
    )
    .returning({ id: dealInvestorClass.id });
  if (deleted.length > 0) scheduleDealSaasBillingSync(params.dealId);
  return deleted.length > 0;
}
