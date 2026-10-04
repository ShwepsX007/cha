import { NextRequest, NextResponse } from "next/server";
import { desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 100) || "";
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const numericId = /^\d+$/.test(query) ? Number(query) : null;
    const filters = query
      ? [
          ilike(users.username, `%${escaped}%`),
          ilike(users.displayName, `%${escaped}%`),
          ...(numericId && Number.isSafeInteger(numericId) ? [eq(users.id, numericId)] : []),
        ]
      : [];

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        role: users.role,
        bannedUntil: users.bannedUntil,
        banReason: users.banReason,
        matrixResetRequired: users.matrixResetRequired,
        createdAt: users.createdAt,
        lastSeen: users.lastSeen,
      })
      .from(users)
      .where(filters.length ? or(...filters) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(200);

    return NextResponse.json({ users: rows, search: query }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Не удалось загрузить пользователей" }, { status: 500 });
  }
}
