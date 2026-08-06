import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../database/db.js";
import {
  userPageNavigations,
  userPortalSessions,
  users,
} from "../../schema/schema.js";

export type UserActivityPageCount = {
  pagePath: string;
  pageLabel: string;
  count: number;
};

export type UserActivityRow = {
  userId: string;
  userName: string;
  email: string;
  loginAt: string;
  logoutAt: string | null;
  isActive: boolean;
  pageNavigations: UserActivityPageCount[];
};

/** Start a new portal session on successful sign-in. */
export async function startUserPortalSession(userId: string): Promise<string> {
  const [row] = await db
    .insert(userPortalSessions)
    .values({ userId })
    .returning({ id: userPortalSessions.id });
  return row.id;
}

/** Close the open session for this user (if any). */
export async function endUserPortalSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .update(userPortalSessions)
    .set({ logoutAt: sql`now()` })
    .where(
      and(
        eq(userPortalSessions.id, sessionId),
        eq(userPortalSessions.userId, userId),
        isNull(userPortalSessions.logoutAt),
      ),
    )
    .returning({ id: userPortalSessions.id });
  return Boolean(row);
}

/**
 * Resume tracking after refresh: reuse open session or start a new one.
 */
export async function ensureUserPortalSession(
  userId: string,
  sessionId?: string | null,
): Promise<string> {
  if (sessionId) {
    const [open] = await db
      .select({ id: userPortalSessions.id })
      .from(userPortalSessions)
      .where(
        and(
          eq(userPortalSessions.id, sessionId),
          eq(userPortalSessions.userId, userId),
          isNull(userPortalSessions.logoutAt),
        ),
      )
      .limit(1);
    if (open) return open.id;
  }

  const [latestOpen] = await db
    .select({ id: userPortalSessions.id })
    .from(userPortalSessions)
    .where(
      and(
        eq(userPortalSessions.userId, userId),
        isNull(userPortalSessions.logoutAt),
      ),
    )
    .orderBy(desc(userPortalSessions.loginAt))
    .limit(1);
  if (latestOpen) return latestOpen.id;

  return startUserPortalSession(userId);
}

export async function recordUserPageNavigation(params: {
  userId: string;
  sessionId: string;
  pagePath: string;
  pageLabel: string;
}): Promise<void> {
  const pagePath = params.pagePath.trim().slice(0, 2048);
  if (!pagePath) return;
  const pageLabel = params.pageLabel.trim().slice(0, 255);

  await db
    .insert(userPageNavigations)
    .values({
      userId: params.userId,
      sessionId: params.sessionId,
      pagePath,
      pageLabel,
      visitCount: 1,
    })
    .onConflictDoUpdate({
      target: [userPageNavigations.sessionId, userPageNavigations.pagePath],
      set: {
        visitCount: sql`${userPageNavigations.visitCount} + 1`,
        pageLabel: sql`excluded.page_label`,
        updatedAt: sql`now()`,
      },
    });
}

function displayNameFromUser(row: {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
}): string {
  const full = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
  if (full) return full;
  const un = String(row.username ?? "").trim();
  if (un) return un;
  return String(row.email ?? "").trim() || "—";
}

/** Currently logged-in users (open session) with page navigation counts for that session. */
export async function getUserActivityMetrics(): Promise<UserActivityRow[]> {
  const openSessions = await db
    .select({
      sessionId: userPortalSessions.id,
      userId: userPortalSessions.userId,
      loginAt: userPortalSessions.loginAt,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
    })
    .from(userPortalSessions)
    .innerJoin(users, eq(users.id, userPortalSessions.userId))
    .where(isNull(userPortalSessions.logoutAt))
    .orderBy(desc(userPortalSessions.loginAt));

  if (openSessions.length === 0) return [];

  const sessionIds = openSessions.map((s) => s.sessionId);
  const navRows = await db
    .select({
      sessionId: userPageNavigations.sessionId,
      pagePath: userPageNavigations.pagePath,
      pageLabel: userPageNavigations.pageLabel,
      visitCount: userPageNavigations.visitCount,
    })
    .from(userPageNavigations)
    .where(inArray(userPageNavigations.sessionId, sessionIds))
    .orderBy(desc(userPageNavigations.visitCount));

  const navBySession = new Map<string, UserActivityPageCount[]>();
  for (const n of navRows) {
    const list = navBySession.get(n.sessionId) ?? [];
    list.push({
      pagePath: n.pagePath,
      pageLabel: n.pageLabel || n.pagePath,
      count: Number(n.visitCount) || 0,
    });
    navBySession.set(n.sessionId, list);
  }

  return openSessions.map((s) => {
    const loginAt = s.loginAt?.toISOString?.() ?? "";
    return {
      userId: s.userId,
      userName: displayNameFromUser(s),
      email: s.email,
      loginAt,
      logoutAt: null,
      isActive: true,
      pageNavigations: navBySession.get(s.sessionId) ?? [],
    };
  });
}
