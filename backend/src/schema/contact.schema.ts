import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.schema/company.js";
import { users } from "./auth.schema/signin.js";
import { addDealForm } from "./deal.schema/add-deal-form.schema.js";

/** CRM-style contacts added from the portal; `created_by` is the authenticated user who saved the row */
export const contact = pgTable("contact", {
  id: uuid("id").defaultRandom().primaryKey(),
  /**
   * Same `companies.id` as `users.organization_id` for the creating user (set on insert via
   * `resolveOrganizationIdForUserId` — usually the creator’s `users.organization_id`, or
   * resolved from `companies` via the portal user’s `organization_id`).
   */
  organizationId: uuid("organization_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  firstName: varchar("first_name", { length: 200 }).notNull(),
  lastName: varchar("last_name", { length: 200 }).notNull(),
  /** Concat of first + last name; kept in sync on write for now. */
  fullName: varchar("full_name", { length: 400 }).notNull().default(""),
  email: varchar("email", { length: 255 }).notNull(),
  /** True when this email is linked to a row in `users` — excluded from All Contacts lists. */
  isPortalUser: boolean("is_portal_user").notNull().default(false),
  /**
   * Self-registered investor CRM rows (no company) — visible to platform admins only
   * unless `visibleToUsers` is true.
   */
  platformAdminOnly: boolean("platform_admin_only").notNull().default(false),
  /**
   * Self-registered investor opted in (My account) to appear in company All Contacts.
   */
  visibleToUsers: boolean("visible_to_users").notNull().default(false),
  phone: varchar("phone", { length: 64 }).notNull().default(""),
  note: text("note").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull(),
  lists: jsonb("lists").$type<string[]>().notNull(),
  owners: jsonb("owners").$type<string[]>().notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  /**
   * Per-contact offering visibility for the investor portal.
   * `ALL_OFFERINGS` | `HIDE_OFFERINGS` | `506B_ONLY` | `506C_ONLY` — nullable when unset.
   */
  showOfferingsVisibility: varchar("show_offerings_visibility", { length: 32 }),
  /** Accreditation status label; nullable when unset. */
  accreditationStatus: text("accreditation_status"),
  /** Date the relationship with this contact was established; nullable when unset. */
  knownSince: date("known_since"),
  /**
   * Whether this contact has a 506(b) pre-existing relationship.
   * `YES` | `NO` — defaults to `NO`.
   */
  relationship506b: varchar("relationship_506b", { length: 16 }).default("NO"),
  lastEditReason: text("last_edit_reason"),
  /** True after a portal signup invitation email was successfully sent. */
  invitationEmailSent: boolean("invitation_email_sent").notNull().default(false),
  /**
   * Deal whose lead / admin / co-sponsor invite link attributed this contact.
   * Null for contacts added by hand or org-only invite links.
   */
  referredByDealId: uuid("referred_by_deal_id").references(() => addDealForm.id, {
    onDelete: "set null",
  }),
  /** How this contact first entered the CRM: manual, csv, excel, invite_link, portal_signup, ghl. */
  importSource: varchar("import_source", { length: 32 })
    .notNull()
    .default("manual"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ContactRow = typeof contact.$inferSelect;
export type ContactInsert = typeof contact.$inferInsert;

export type ContactImportCounts = {
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  invalidRows: number;
  importedRows: number;
  skippedRows: number;
  updatedRows: number;
};

export const contactImportBatch = pgTable("contact_import_batch", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  fileName: varchar("file_name", { length: 255 }).notNull().default(""),
  fileType: varchar("file_type", { length: 16 }).notNull().default("csv"),
  headers: jsonb("headers").$type<string[]>().notNull(),
  mapping: jsonb("mapping").$type<Record<string, string | null>>(),
  duplicateMode: varchar("duplicate_mode", { length: 16 })
    .notNull()
    .default("skip"),
  status: varchar("status", { length: 32 }).notNull().default("parsed"),
  counts: jsonb("counts").$type<ContactImportCounts | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const contactImportRow = pgTable("contact_import_row", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => contactImportBatch.id, { onDelete: "cascade" }),
  rowIndex: integer("row_index").notNull(),
  raw: jsonb("raw").$type<Record<string, string>>().notNull(),
  normalized: jsonb("normalized").$type<Record<string, unknown> | null>(),
  errors: jsonb("errors").$type<string[]>().notNull(),
  duplicateContactId: uuid("duplicate_contact_id").references(() => contact.id, {
    onDelete: "set null",
  }),
  duplicateMatch: varchar("duplicate_match", { length: 16 }),
  status: varchar("status", { length: 32 }).notNull().default("parsed"),
  importContactId: uuid("import_contact_id").references(() => contact.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ContactImportBatchRow = typeof contactImportBatch.$inferSelect;
export type ContactImportBatchInsert = typeof contactImportBatch.$inferInsert;
export type ContactImportRowRow = typeof contactImportRow.$inferSelect;
export type ContactImportRowInsert = typeof contactImportRow.$inferInsert;

export type EmailTemplateAttachment = {
  fileName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
};

/** Reusable contact email templates, scoped by organization. */
export const contactEmailTemplate = pgTable("contact_email_template", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  name: varchar("name", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 255 }).notNull().default(""),
  body: text("body").notNull().default(""),
  attachment: jsonb("attachment").$type<EmailTemplateAttachment | null>(),
  archived: boolean("archived").notNull().default(false),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ContactEmailTemplateRow = typeof contactEmailTemplate.$inferSelect;
export type ContactEmailTemplateInsert =
  typeof contactEmailTemplate.$inferInsert;
