import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { ensureConfiguredInitialAdmin } from "@/lib/admin";

export async function GET() {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    const [sessionUser] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, payload.userId));
    if (!sessionUser) {
      return NextResponse.json({ user: null }, { status: 401 });
    }
    await ensureConfiguredInitialAdmin(sessionUser.id, sessionUser.username);

    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        avatarUrl: users.avatarUrl,
        avatarUpdatedAt: users.avatarUpdatedAt,
        role: users.role,
        bannedUntil: users.bannedUntil,
        banReason: users.banReason,
        matrixResetRequired: users.matrixResetRequired,
      })
      .from(users)
      .where(eq(users.id, payload.userId));

    if (!user) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    // Update last seen
    await db.update(users).set({ lastSeen: new Date() }).where(eq(users.id, user.id));

    return NextResponse.json({
      user: {
        ...user,
        displayName: user.displayName || user.username,
        avatarUrl: user.avatarUrl || null,
        avatarUpdatedAt: user.avatarUpdatedAt instanceof Date ? user.avatarUpdatedAt.toISOString() : user.avatarUpdatedAt ?? null,
        bannedUntil: user.bannedUntil instanceof Date ? user.bannedUntil.toISOString() : user.bannedUntil ?? null,
      },
    });
  } catch {
    return NextResponse.json({ user: null }, { status: 401 });
  }
}
