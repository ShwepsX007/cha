import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

export interface AdminPrincipal {
  id: number;
  username: string;
  displayName: string;
  role: "admin";
}

export type AdminAuthResult =
  | { admin: AdminPrincipal; response?: never }
  | { admin?: never; response: NextResponse };

/** Promote the configured bootstrap username only while the database has no admins. */
export async function ensureConfiguredInitialAdmin(userId: number, username: string): Promise<void> {
  const initialIdentifier = process.env.INITIAL_ADMIN_IDENTIFIER?.trim().toLocaleLowerCase("en-US");
  if (!initialIdentifier || username.trim().toLocaleLowerCase("en-US") !== initialIdentifier) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(734729105)`);
    const [existingAdmin] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    if (existingAdmin) return;
    await tx.update(users).set({ role: "admin" }).where(eq(users.id, userId));
  });
}

export async function writeAdminAuditLog(input: {
  adminId: number;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(adminAuditLogs).values({
    adminId: input.adminId,
    action: input.action.slice(0, 100),
    targetType: input.targetType?.slice(0, 50) ?? null,
    targetId: input.targetId?.slice(0, 100) ?? null,
    details: input.details ?? null,
  });
}

export async function requireAdmin(): Promise<AdminAuthResult> {
  const session = await getCurrentUser();
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  try {
    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, session.userId));

    if (!user) {
      return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (user.role !== "admin") {
      return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }

    return { admin: { ...user, role: "admin" } };
  } catch {
    return { response: NextResponse.json({ error: "Не удалось проверить права администратора" }, { status: 500 }) };
  }
}
