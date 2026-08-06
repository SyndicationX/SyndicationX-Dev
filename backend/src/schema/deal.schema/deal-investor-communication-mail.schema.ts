import {
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "../auth.schema/signin.js";
import { contactEmailTemplate } from "../contact.schema.js";
import { addDealForm } from "./add-deal-form.schema.js";

export type DealInvestorCommunicationRecipient = {
  id: string;
  displayName: string;
  email: string;
  groups: ("investor" | "deal_member")[];
  roleLabel?: string;
};

/** Mail send log for Investor Communication tab (`investor_communication_logs`). */
export const investorCommunicationLogs = pgTable("investor_communication_logs", {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id").references(() => contactEmailTemplate.id, {
      onDelete: "set null",
    }),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => addDealForm.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    senderName: varchar("sender_name", { length: 255 }).notNull().default(""),
    subject: varchar("subject", { length: 500 }).notNull().default(""),
    recipientUsers: jsonb("recipient_users")
      .$type<DealInvestorCommunicationRecipient[]>()
      .notNull()
      .default([]),
    mailStatus: varchar("mail_status", { length: 32 }).notNull().default("sent"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

/** @deprecated Use `investorCommunicationLogs` */
export const dealInvestorCommunicationMail = investorCommunicationLogs;

export type InvestorCommunicationLogRow =
  typeof investorCommunicationLogs.$inferSelect;
export type InvestorCommunicationLogInsert =
  typeof investorCommunicationLogs.$inferInsert;
export type DealInvestorCommunicationMailRow = InvestorCommunicationLogRow;
export type DealInvestorCommunicationMailInsert = InvestorCommunicationLogInsert;
