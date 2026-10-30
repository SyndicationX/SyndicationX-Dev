import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";
import { companies } from "../company.schema/company.js";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).notNull().default("platform_user"),
  /**
   * Self-serve “Are you an” answer: `investor`, `syndicator`, or `both`.
   * Empty for invite signups and accounts created before this was stored.
   */
  signupAs: varchar("signup_as", { length: 32 }).notNull().default(""),
  userStatus: varchar("user_status", { length: 50 }).notNull().default("active"),
  userSignupCompleted: varchar("user_signup_completed", { length: 10 })
    .notNull()
    .default("true"),
  /** Same `companies.id` as `contact.organization_id` — user’s company membership. */
  organizationId: uuid("organization_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  firstName: varchar("first_name", { length: 100 }).notNull().default(""),
  lastName: varchar("last_name", { length: 100 }).notNull().default(""),
  phone: varchar("phone", { length: 32 }).notNull().default(""),
  /** Sponsor whose investor invite link was used at signup; null for direct signups. */
  referredByUserId: uuid("referred_by_user_id").references(
    (): AnyPgColumn => users.id,
    { onDelete: "set null" },
  ),
  /** Company on that invite link. Not a company membership — investors stay out of the org. */
  referredByCompanyId: uuid("referred_by_company_id").references(
    () => companies.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
  /** Portal user who sent the organization invite. Null for self-serve signups. */
  invitedByUserId: uuid("invited_by_user_id").references(
    (): AnyPgColumn => users.id,
    { onDelete: "set null" },
  ),
  /** When the organization invitation was sent. */
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  /**
   * Stripe customer that holds this user’s saved cards.
   * Company and deal customers stay separate so a card is not an organization record.
   */
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
});

export type UserRow = typeof users.$inferSelect;
