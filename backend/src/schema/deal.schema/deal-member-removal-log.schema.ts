import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../auth.schema/signin.js";
import { addDealForm } from "./add-deal-form.schema.js";

/** Full database rows removed by one delete. Rows that were kept are omitted. */
export type DealRosterRemovalSnapshot = {
  investments: Record<string, unknown>[];
  lpInvestors: Record<string, unknown>[];
  rosterMember: Record<string, unknown> | null;
};

/**
 * Append-only record of a deal roster removal.
 * `deleted_by_*` is the portal user who performed the delete.
 */
export const dealMemberRemovalLogs = pgTable("deal_member_removal_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => addDealForm.id, { onDelete: "cascade" }),
  /** `deal_investment.id`, `deal_member.id`, or `deal_lp_investor.id` that was removed. */
  removedRowId: uuid("removed_row_id").notNull(),
  removedContactId: text("removed_contact_id").notNull().default(""),
  removedName: text("removed_name").notNull().default(""),
  removedRole: text("removed_role").notNull().default(""),
  deletedByUserId: uuid("deleted_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  deletedByName: text("deleted_by_name").notNull().default(""),
  /** Complete rows that this delete removed. */
  removedSnapshot: jsonb("removed_snapshot")
    .$type<DealRosterRemovalSnapshot>()
    .notNull()
    .default({ investments: [], lpInvestors: [], rosterMember: null }),
  /** `remove_investment`, `remove_investor`, or the legacy roster delete. */
  action: text("action").notNull().default(""),
  reason: text("reason").notNull().default(""),
  affectedIds: jsonb("affected_ids").$type<string[]>().notNull().default([]),
  confirmed: boolean("confirmed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type DealMemberRemovalLogRow = typeof dealMemberRemovalLogs.$inferSelect;
export type DealMemberRemovalLogInsert = typeof dealMemberRemovalLogs.$inferInsert;
