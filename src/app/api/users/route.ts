import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { and, ilike, or, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 20;

/**
 * There is no full user directory anymore: accounts can only be found by an
 * explicit search (username or display name, at least MIN_QUERY_LENGTH
 * characters). A new user cannot enumerate who else is registered — this is
 * the discoverability rule the project owner asked for.
 */
export async function GET(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (query.length < MIN_QUERY_LENGTH) {
      return NextResponse.json(
        {
          users: [],
          search: query,
          needsSearch: true,
          hint: `Введите минимум ${MIN_QUERY_LENGTH} символа, чтобы найти пользователя`,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        avatarUrl: users.avatarUrl,
        avatarUpdatedAt: users.avatarUpdatedAt,
        lastSeen: users.lastSeen,
      })
      .from(users)
      .where(
        and(
          sql`${users.id} <> ${payload.userId}`,
          or(
            ilike(users.username, `%${escaped}%`),
            ilike(users.displayName, `%${escaped}%`),
          ),
        ),
      )
      .limit(RESULT_LIMIT);

    return NextResponse.json({ users: rows, search: query }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Users search error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
