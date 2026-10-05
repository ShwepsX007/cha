import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    }
    const password = (body as { password?: unknown }).password;
    if (typeof password !== "string" || password.length < 1 || password.length > 1024) {
      return NextResponse.json({ error: "Введите пароль аккаунта" }, { status: 400 });
    }

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, currentUser.userId));
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return NextResponse.json({ error: "Неверный пароль аккаунта" }, { status: 401 });
    }

    return NextResponse.json({ verified: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Account password verification failed");
    return NextResponse.json({ error: "Не удалось проверить пароль аккаунта" }, { status: 500 });
  }
}
