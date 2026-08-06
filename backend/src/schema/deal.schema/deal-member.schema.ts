import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "../auth.schema/signin.js";
import { addDealForm } from "./add-deal-form.schema.js";

/**
 * Lean roster row per member on a deal (details also live on `deal_investment`).
 * Unique (deal_id, contact_member_id).
 */
export const dealMember = pgTable(
  "deal_member",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => addDealForm.id, { onDelete: "cascade" }),
    /** Portal user who added this member (JWT `sub`). */
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    /** Contact / portal user id for this member (matches `deal_investment.contact_id`). */
    contactMemberId: text("contact_member_id").notNull().default(""),
    dealMemberRole: text("deal_member_role").notNull().default(""),
    sendInvitationMail: text("send_invitation_mail").notNull().default("no"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("deal_member_deal_id_contact_member_id_uidx").on(
      t.dealId,
      t.contactMemberId,
    ),
  ],
);

export type DealMemberRow = typeof dealMember.$inferSelect;
export type DealMemberInsert = typeof dealMember.$inferInsert;
