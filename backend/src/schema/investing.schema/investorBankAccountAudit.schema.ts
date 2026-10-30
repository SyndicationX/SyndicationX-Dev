import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "../auth.schema/signin.js";

/**
 * Soft-deleted Connect bank accounts. The Stripe account is left in place;
 * local profile links are cleared so the account leaves the active table and
 * Bank Account Setup.
 */
export const userInvestorConnectBankDeletions = pgTable(
  "user_investor_connect_bank_deletions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stripeConnectAccountId: varchar("stripe_connect_account_id", {
      length: 255,
    }).notNull(),
    profileIds: jsonb("profile_ids").$type<string[]>().notNull(),
    deletedByUserId: uuid("deleted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("user_investor_connect_bank_deletions_uidx").on(
      t.userId,
      t.stripeConnectAccountId,
    ),
    index("user_investor_connect_bank_deletions_user_idx").on(t.userId),
  ],
);

/** Append-only history for bank account create, update, and delete. */
export const investorBankAccountAuditLogs = pgTable(
  "investor_bank_account_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** created | updated | deleted */
    action: varchar("action", { length: 32 }).notNull(),
    bankAccountRecordId: varchar("bank_account_record_id", {
      length: 255,
    }).notNull(),
    profileIds: jsonb("profile_ids").$type<string[]>().notNull(),
    changesJson: jsonb("changes_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("investor_bank_account_audit_owner_idx").on(t.ownerUserId),
    index("investor_bank_account_audit_record_idx").on(t.bankAccountRecordId),
    index("investor_bank_account_audit_created_idx").on(t.createdAt),
  ],
);

export type InvestorBankAccountAuditAction = "created" | "updated" | "deleted";
