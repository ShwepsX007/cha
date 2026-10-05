import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireProfile, sanitizeDisplayName, validateDisplayName } from "@/lib/profile";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;

  try {
    const body = await req.json();
    const displayName = sanitizeDisplayName(body?.displayName);
    const validationError = validateDisplayName(displayName);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

    const [updated] = await db
      .update(users)
      .set({ displayName })
      .where(eq(users.id, auth.user.id))
      .returning({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        avatarUrl: users.avatarUrl,
        role: users.role,
        bannedUntil: users.bannedUntil,
        banReason: users.banReason,
      });

    if (!updated) return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    return NextResponse.json({ user: updated }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Не удалось сохранить имя" }, { status: 500 });
  }
}
