import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createToken } from "@/lib/auth";
import { createMatrixSession, type MatrixLoginResult } from "@/lib/matrix/server";
import { ensureGeneralChatMembership } from "@/lib/chats";

// Reserved for the Telegram bootstrap bot: anyone who registers this name
// before the bot runs would appear in the admin panel as the bot account.
const RESERVED_USERNAMES = new Set(["telegram_admin"]);

const AVATAR_COLORS = [
  "#6C5CE7", "#A29BFE", "#00B894", "#00CEC9", "#0984E3",
  "#E17055", "#FDCB6E", "#E84393", "#55A3F5", "#FF7675",
];

export async function POST(req: NextRequest) {
  try {
    const { username, password, displayName, matrixDeviceId } = await req.json();

    if (!username || !password) {
      return NextResponse.json({ error: "Логин и пароль обязательны" }, { status: 400 });
    }

    if (username.length < 3 || password.length < 4) {
      return NextResponse.json(
        { error: "Логин минимум 3 символа, пароль минимум 4" },
        { status: 400 }
      );
    }

    if (RESERVED_USERNAMES.has(username.toLowerCase())) {
      return NextResponse.json(
        { error: "Этот логин зарезервирован для Telegram-админа" },
        { status: 409 },
      );
    }

    const existing = await db.select().from(users).where(eq(users.username, username));
    if (existing.length > 0) {
      return NextResponse.json({ error: "Пользователь уже существует" }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    const [user] = await db.transaction(async (tx) => {
      // Serialize the first-admin decision so concurrent registrations cannot
      // both observe an empty admin set and both become the bootstrap admin.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(734729105)`);
      const [existingAdmin] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "admin"))
        .limit(1);
      return tx
        .insert(users)
        .values({
          username,
          displayName: displayName || username,
          passwordHash,
          avatarColor,
          role: existingAdmin ? "user" : "admin",
        })
        .returning();
    });

    // Create the public chat if needed and join this account to it. The helper
    // checks membership for this exact user — the previous code looked at any
    // member row of the chat and could insert duplicate memberships.
    await ensureGeneralChatMembership(user.id);

    let matrix: MatrixLoginResult = { availability: "unavailable", session: null };
    try {
      matrix = await createMatrixSession({
        appUserId: user.id,
        username: user.username,
        displayName: user.displayName,
        password,
        deviceId: matrixDeviceId,
      });
    } catch (error) {
      // Registration remains available for the public chat if Matrix is offline.
      console.error("Matrix session unavailable:", error);
    }

    const token = await createToken(user.id, user.username);

    const response = NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
        avatarUrl: user.avatarUrl,
        avatarUpdatedAt: null,
        role: user.role,
        bannedUntil: user.bannedUntil,
        banReason: user.banReason,
        matrixResetRequired: user.matrixResetRequired,
      },
      matrixAvailability: matrix.availability,
      matrixSession: matrix.session,
      matrixResetRequired: false,
    });
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch (error) {
    console.error("Register error:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
