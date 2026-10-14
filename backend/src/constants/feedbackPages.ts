import type { FeedbackSubPageOption } from "../schema/feedback.schema.js";

export type FeedbackPageOption = {
  pageKey: string;
  pageLabel: string;
  sortOrder: string;
  subPages: FeedbackSubPageOption[];
};

function tabs(...labels: string[]): FeedbackSubPageOption[] {
  return labels.map((label) => ({
    key: label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
    label,
  }));
}

/** Default application pages / tabs. Platform admin can edit these in Feedback Management. */
export const DEFAULT_FEEDBACK_PAGE_CATALOG: FeedbackPageOption[] = [
  {
    pageKey: "dashboard",
    pageLabel: "Dashboard",
    sortOrder: "10",
    subPages: tabs("Overview"),
  },
  {
    pageKey: "crm",
    pageLabel: "CRM",
    sortOrder: "20",
    subPages: tabs(
      "Overview",
      "All Contacts",
      "Pipeline",
      "Inbox",
      "Campaigns",
      "Email Templates",
      "Meetings",
      "Pages & Branding",
      "Import",
      "Investor view",
    ),
  },
  {
    pageKey: "deals",
    pageLabel: "Deals",
    sortOrder: "30",
    subPages: tabs(
      "Deal list",
      "Create deal",
      "Offering Details",
      "Documents",
      "eSign Templates",
      "Investors",
      "Investor Communication",
      "Distributions",
      "General Partners",
      "Class Setup",
      "Distribution Setup",
    ),
  },
  {
    pageKey: "reporting",
    pageLabel: "Reporting",
    sortOrder: "40",
    subPages: tabs("Overview"),
  },
  {
    pageKey: "investments",
    pageLabel: "Investments",
    sortOrder: "50",
    subPages: tabs("List", "Investment detail", "Documents", "Distributions"),
  },
  {
    pageKey: "profiles",
    pageLabel: "Profiles",
    sortOrder: "60",
    subPages: tabs("List", "Add profile", "Edit profile"),
  },
  {
    pageKey: "settings",
    pageLabel: "Settings",
    sortOrder: "70",
    subPages: tabs(
      "Company",
      "Personal",
      "Password",
      "Billing",
      "Email",
      "Contact attributes",
      "Offerings",
      "Members",
    ),
  },
  {
    pageKey: "customers",
    pageLabel: "Customers",
    sortOrder: "80",
    subPages: tabs("Companies", "Members", "Deals"),
  },
  {
    pageKey: "platform_metrics",
    pageLabel: "Platform Metrics",
    sortOrder: "90",
    subPages: tabs("Overview", "User activity"),
  },
  {
    pageKey: "notifications",
    pageLabel: "Notifications",
    sortOrder: "100",
    subPages: tabs("Inbox"),
  },
  {
    pageKey: "account",
    pageLabel: "My account",
    sortOrder: "110",
    subPages: tabs("Company", "Personal", "Password"),
  },
  {
    pageKey: "other",
    pageLabel: "Other",
    sortOrder: "999",
    subPages: tabs("General"),
  },
];
