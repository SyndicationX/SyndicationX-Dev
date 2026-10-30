import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../auth.schema/signin.js";
import { addDealForm } from "./add-deal-form.schema.js";

/**
 * Investor-only view of a deal in Investing.
 * Archive hides it under Archives. Removal hides a deleted soft commitment
 * even if a roster invite would otherwise keep the deal on the list.
 * Neither flag changes the sponsor's deal record.
 */
export const investorDealParticipation = pgTable(
  "investor_deal_participation",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => addDealForm.id, { onDelete: "cascade" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.dealId] })],
);

export type InvestorDealParticipationRow =
  typeof investorDealParticipation.$inferSelect;
