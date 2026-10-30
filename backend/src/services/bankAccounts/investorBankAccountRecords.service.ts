import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database/db.js";
import {
  investorBankAccountAuditLogs,
  userInvestorConnectBankDeletions,
  userInvestorProfiles,
  type InvestorBankAccountAuditAction,
} from "../../schema/schema.js";
import {
  distributionBankFromDbRow,
  distributionBankFromFormSnapshot,
} from "../investing/investorProfileDistributionBank.js";
import { resolveConnectBankAccountSummary } from "../payments/connectBankAccountSummary.js";
import {
  bankDetailsArePresent,
  savedProfileBankDetailsPresent,
  type BankAccountPresence,
} from "./bankAccountSetup.js";

export const PROFILE_BANK_RECORD_PREFIX = "profile-bank:";
import {
  maskKeepLast4,
  redactBankAccountAuditChanges,
} from "./bankAccountAudit.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: string): string | null {
  const t = value.trim();
  return UUID_RE.test(t) ? t : null;
}

export async function archivedConnectAccountIds(
  userId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      accountId: userInvestorConnectBankDeletions.stripeConnectAccountId,
    })
    .from(userInvestorConnectBankDeletions)
    .where(eq(userInvestorConnectBankDeletions.userId, userId));
  return new Set(rows.map((row) => row.accountId.trim()).filter(Boolean));
}

export async function isInvestorConnectBankArchived(
  userId: string,
  accountId: string,
): Promise<boolean> {
  const id = accountId.trim();
  if (!uuid(userId) || !id) return false;
  const [row] = await db
    .select({ id: userInvestorConnectBankDeletions.id })
    .from(userInvestorConnectBankDeletions)
    .where(
      and(
        eq(userInvestorConnectBankDeletions.userId, userId),
        eq(userInvestorConnectBankDeletions.stripeConnectAccountId, id),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function recordInvestorBankAccountAudit(params: {
  actorUserId: string;
  ownerUserId: string;
  action: InvestorBankAccountAuditAction;
  bankAccountRecordId: string;
  profileIds: string[];
  changes: Record<string, unknown>;
}): Promise<void> {
  const actorUserId = uuid(params.actorUserId);
  const ownerUserId = uuid(params.ownerUserId);
  const bankAccountRecordId = params.bankAccountRecordId.trim();
  if (!actorUserId || !ownerUserId || !bankAccountRecordId) return;
  const profileIds = [
    ...new Set(params.profileIds.map((id) => id.trim()).filter(Boolean)),
  ];
  await db.insert(investorBankAccountAuditLogs).values({
    actorUserId,
    ownerUserId,
    action: params.action,
    bankAccountRecordId,
    profileIds,
    changesJson: redactBankAccountAuditChanges(params.changes) as Record<
      string,
      unknown
    >,
  });
}

type ProfileBankRow = {
  id: string;
  userId: string;
  accountId: string | null;
  status: string;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  archived: boolean;
  isDraft: boolean;
  achBankName: string;
  achRoutingNumber: string;
  achAccountNumber: string;
  achBankAddress: string;
  achBankAccountType: string;
  distributionMethod: string;
  bankAccountQuery: string;
  checkPayeeName: string;
  checkMailingAddressId: string | null;
  formSnapshot: Record<string, unknown> | null;
};

function presenceFromRows(rows: ProfileBankRow[]): BankAccountPresence[] {
  const byAccount = new Map<string, BankAccountPresence>();
  for (const row of rows) {
    if (row.archived || row.isDraft) continue;
    const accountId = row.accountId?.trim() || "";
    if (!accountId) continue;
    const detailsPresent = bankDetailsArePresent({
      accountId,
      detailsSubmitted: row.detailsSubmitted,
      payoutsEnabled: row.payoutsEnabled,
      status: row.status,
    });
    const existing = byAccount.get(accountId);
    if (existing) {
      existing.profileIds = [...(existing.profileIds ?? []), row.id];
      if (detailsPresent) existing.detailsPresent = true;
    } else {
      byAccount.set(accountId, {
        id: accountId,
        deleted: false,
        detailsPresent,
        profileIds: [row.id],
      });
    }
  }
  for (const row of rows) {
    if (row.archived || row.isDraft) continue;
    const fromDb = distributionBankFromDbRow(row);
    const fromSnapshot = distributionBankFromFormSnapshot(row.formSnapshot);
    const bank = {
      achBankName: fromDb.achBankName || fromSnapshot.achBankName,
      achRoutingNumber: fromDb.achRoutingNumber || fromSnapshot.achRoutingNumber,
      achAccountNumber: fromDb.achAccountNumber || fromSnapshot.achAccountNumber,
    };
    if (!savedProfileBankDetailsPresent(bank)) continue;
    byAccount.set(`${PROFILE_BANK_RECORD_PREFIX}${row.id}`, {
      id: `${PROFILE_BANK_RECORD_PREFIX}${row.id}`,
      deleted: false,
      detailsPresent: true,
      profileIds: [row.id],
    });
  }
  return [...byAccount.values()];
}

/** Active bank accounts and the profiles that use them, with deletions removed. */
export async function listActiveBankAccountsForUsers(
  userIds: string[],
): Promise<Map<string, BankAccountPresence[]>> {
  const ids = [...new Set(userIds.map((id) => uuid(id)).filter(Boolean))] as string[];
  const out = new Map<string, BankAccountPresence[]>();
  if (ids.length === 0) return out;

  const [profiles, deletions] = await Promise.all([
    db
      .select({
        id: userInvestorProfiles.id,
        userId: userInvestorProfiles.userId,
        accountId: userInvestorProfiles.stripeConnectAccountId,
        status: userInvestorProfiles.stripeConnectStatus,
        detailsSubmitted: userInvestorProfiles.stripeConnectDetailsSubmitted,
        payoutsEnabled: userInvestorProfiles.stripeConnectPayoutsEnabled,
        archived: userInvestorProfiles.archived,
        isDraft: userInvestorProfiles.isDraft,
        achBankName: userInvestorProfiles.achBankName,
        achRoutingNumber: userInvestorProfiles.achRoutingNumber,
        achAccountNumber: userInvestorProfiles.achAccountNumber,
        achBankAddress: userInvestorProfiles.achBankAddress,
        achBankAccountType: userInvestorProfiles.achBankAccountType,
        distributionMethod: userInvestorProfiles.distributionMethod,
        bankAccountQuery: userInvestorProfiles.bankAccountQuery,
        checkPayeeName: userInvestorProfiles.checkPayeeName,
        checkMailingAddressId: userInvestorProfiles.checkMailingAddressId,
        formSnapshot: userInvestorProfiles.formSnapshot,
      })
      .from(userInvestorProfiles)
      .where(inArray(userInvestorProfiles.userId, ids)),
    db
      .select({
        userId: userInvestorConnectBankDeletions.userId,
        accountId: userInvestorConnectBankDeletions.stripeConnectAccountId,
      })
      .from(userInvestorConnectBankDeletions)
      .where(inArray(userInvestorConnectBankDeletions.userId, ids)),
  ]);

  const archivedByUser = new Map<string, Set<string>>();
  for (const row of deletions) {
    const set = archivedByUser.get(row.userId) ?? new Set<string>();
    set.add(row.accountId.trim());
    archivedByUser.set(row.userId, set);
  }

  const grouped = new Map<string, ProfileBankRow[]>();
  for (const row of profiles) {
    const list = grouped.get(row.userId) ?? [];
    list.push(row);
    grouped.set(row.userId, list);
  }

  for (const userId of ids) {
    const archived = archivedByUser.get(userId) ?? new Set<string>();
    const accounts = presenceFromRows(grouped.get(userId) ?? []).filter(
      (account) => !archived.has(account.id),
    );
    out.set(userId, accounts);
  }
  return out;
}

export async function archiveInvestorBankAccount(params: {
  investorUserId: string;
  actorUserId: string;
  accountId: string;
}): Promise<
  | { ok: true; profileIds: string[] }
  | { ok: false; status: number; message: string }
> {
  const userId = uuid(params.investorUserId);
  const actorUserId = uuid(params.actorUserId);
  const accountId = params.accountId.trim();
  if (!userId || !actorUserId || !accountId) {
    return { ok: false, status: 400, message: "Invalid bank account." };
  }
  if (accountId.startsWith(PROFILE_BANK_RECORD_PREFIX)) {
    return archiveSavedProfileBank({
      userId,
      actorUserId,
      accountId,
    });
  }

  const linked = await db
    .select({
      id: userInvestorProfiles.id,
      profileName: userInvestorProfiles.profileName,
      status: userInvestorProfiles.stripeConnectStatus,
    })
    .from(userInvestorProfiles)
    .where(
      and(
        eq(userInvestorProfiles.userId, userId),
        eq(userInvestorProfiles.stripeConnectAccountId, accountId),
      ),
    );
  if (linked.length === 0) {
    const archived = await isInvestorConnectBankArchived(userId, accountId);
    return archived
      ? {
          ok: false,
          status: 409,
          message: "That bank account is already deleted.",
        }
      : {
          ok: false,
          status: 404,
          message: "Bank account not found on your profiles.",
        };
  }

  let bankName: string | null = null;
  let accountLast4 = "";
  let routingLast4 = "";
  let accountHolderName: string | null = null;
  try {
    const summary = await resolveConnectBankAccountSummary({ accountId });
    bankName = summary?.bankName ?? null;
    accountLast4 = summary?.last4?.trim() || "";
    routingLast4 = summary?.routingNumber
      ? maskKeepLast4(summary.routingNumber).replace(/^••••/, "")
      : "";
    accountHolderName = summary?.accountHolderName ?? null;
  } catch (err) {
    console.error("archiveInvestorBankAccount summary:", err);
  }

  const profileIds = linked.map((row) => row.id);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(userInvestorConnectBankDeletions).values({
        userId,
        stripeConnectAccountId: accountId,
        profileIds,
        deletedByUserId: actorUserId,
      });
      await tx
        .update(userInvestorProfiles)
        .set({
          stripeConnectAccountId: null,
          stripeConnectDetailsSubmitted: false,
          stripeConnectChargesEnabled: false,
          stripeConnectPayoutsEnabled: false,
          stripeConnectStatus: "not_started",
          stripeConnectUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(userInvestorProfiles.userId, userId),
            eq(userInvestorProfiles.stripeConnectAccountId, accountId),
          ),
        );
      await tx.insert(investorBankAccountAuditLogs).values({
        actorUserId,
        ownerUserId: userId,
        action: "deleted",
        bankAccountRecordId: accountId,
        profileIds,
        changesJson: redactBankAccountAuditChanges({
          bankName,
          accountLast4,
          routingNumber: routingLast4 ? `••••${routingLast4}` : "",
          accountHolderName,
          status: linked[0]?.status ?? "",
          profiles: linked.map((row) => ({
            id: row.id,
            name: row.profileName,
          })),
        }) as Record<string, unknown>,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (/23505|unique/i.test(message)) {
      return {
        ok: false,
        status: 409,
        message: "That bank account is already deleted.",
      };
    }
    console.error("archiveInvestorBankAccount:", err);
    return {
      ok: false,
      status: 500,
      message: "Could not delete the bank account.",
    };
  }

  return { ok: true, profileIds };
}

const SAVED_BANK_SNAPSHOT_KEYS = [
  "achRoutingNumber",
  "achAccountNumber",
  "achBankAddress",
  "achBankName",
  "achBankAccountType",
] as const;

function bankDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function savedBankFingerprint(bank: {
  achRoutingNumber: string;
  achAccountNumber: string;
}): string {
  return `${bankDigits(bank.achRoutingNumber)}|${bankDigits(bank.achAccountNumber)}`;
}

function mergedSavedBank(row: {
  distributionMethod: string;
  achRoutingNumber: string;
  achAccountNumber: string;
  achBankAddress: string;
  achBankName: string;
  achBankAccountType: string;
  bankAccountQuery: string;
  checkPayeeName: string;
  checkMailingAddressId: string | null;
  formSnapshot: Record<string, unknown> | null;
}) {
  const fromDb = distributionBankFromDbRow(row);
  const fromSnapshot = distributionBankFromFormSnapshot(row.formSnapshot);
  return {
    achBankName: fromDb.achBankName || fromSnapshot.achBankName,
    achRoutingNumber: fromDb.achRoutingNumber || fromSnapshot.achRoutingNumber,
    achAccountNumber: fromDb.achAccountNumber || fromSnapshot.achAccountNumber,
  };
}

function snapshotWithoutSavedBank(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot || Array.isArray(snapshot)) return snapshot;
  const next = { ...snapshot };
  for (const key of SAVED_BANK_SNAPSHOT_KEYS) delete next[key];
  return next;
}

/** Remove the ACH bank saved on this investor's profiles. Other account numbers stay. */
async function archiveSavedProfileBank(params: {
  userId: string;
  actorUserId: string;
  accountId: string;
}): Promise<
  | { ok: true; profileIds: string[] }
  | { ok: false; status: number; message: string }
> {
  const profileId = uuid(
    params.accountId.slice(PROFILE_BANK_RECORD_PREFIX.length),
  );
  if (!profileId) {
    return { ok: false, status: 400, message: "Invalid bank account." };
  }
  const profiles = await db
    .select({
      id: userInvestorProfiles.id,
      profileName: userInvestorProfiles.profileName,
      distributionMethod: userInvestorProfiles.distributionMethod,
      achRoutingNumber: userInvestorProfiles.achRoutingNumber,
      achAccountNumber: userInvestorProfiles.achAccountNumber,
      achBankAddress: userInvestorProfiles.achBankAddress,
      achBankName: userInvestorProfiles.achBankName,
      achBankAccountType: userInvestorProfiles.achBankAccountType,
      bankAccountQuery: userInvestorProfiles.bankAccountQuery,
      checkPayeeName: userInvestorProfiles.checkPayeeName,
      checkMailingAddressId: userInvestorProfiles.checkMailingAddressId,
      formSnapshot: userInvestorProfiles.formSnapshot,
    })
    .from(userInvestorProfiles)
    .where(eq(userInvestorProfiles.userId, params.userId));
  const source = profiles.find((row) => row.id === profileId);
  if (!source) {
    return {
      ok: false,
      status: 404,
      message: "Bank account not found on your profiles.",
    };
  }
  const sourceBank = mergedSavedBank(source);
  if (!savedProfileBankDetailsPresent(sourceBank)) {
    return {
      ok: false,
      status: 409,
      message: "That bank account is already deleted.",
    };
  }
  const fingerprint = savedBankFingerprint(sourceBank);
  const targets = profiles.filter(
    (row) => savedBankFingerprint(mergedSavedBank(row)) === fingerprint,
  );
  const profileIds = targets.map((row) => row.id);
  try {
    await db.transaction(async (tx) => {
      for (const row of targets) {
        await tx
          .update(userInvestorProfiles)
          .set({
            achRoutingNumber: "",
            achAccountNumber: "",
            achBankAddress: "",
            achBankName: "",
            achBankAccountType: "",
            formSnapshot: snapshotWithoutSavedBank(row.formSnapshot),
          })
          .where(eq(userInvestorProfiles.id, row.id));
      }
      await tx.insert(investorBankAccountAuditLogs).values({
        actorUserId: params.actorUserId,
        ownerUserId: params.userId,
        action: "deleted",
        bankAccountRecordId: params.accountId,
        profileIds,
        changesJson: redactBankAccountAuditChanges({
          bankName: sourceBank.achBankName,
          routingNumber: sourceBank.achRoutingNumber,
          achAccountNumber: sourceBank.achAccountNumber,
          profiles: targets.map((row) => ({
            id: row.id,
            name: row.profileName,
          })),
        }) as Record<string, unknown>,
      });
    });
  } catch (err) {
    console.error("archiveSavedProfileBank:", err);
    return {
      ok: false,
      status: 500,
      message: "Could not delete the bank account.",
    };
  }
  return { ok: true, profileIds };
}
