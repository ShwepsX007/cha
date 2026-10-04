import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, chats, chatMembers } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createToken } from "@/lib/auth";
import { createMatrixSession, type MatrixLoginResult } from "@/lib/matrix/server";

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

    // Auto-join general chat
    let [generalChat] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.name, "Общий чат"), eq(chats.securityMode, "public")));

    if (!generalChat) {
      [generalChat] = await db
        .insert(chats)
        .values({ name: "Общий чат", isGroup: true, createdBy: user.id, securityMode: "public" })
        .returning();
    }

    // Check if already a member (shouldn't be, but just in case)
    const [existingMember] = await db
      .select()
      .from(chatMembers)
      .where(
        eq(chatMembers.chatId, generalChat.id)
      );

    if (!existingMember || existingMember.userId !== user.id) {
      await db.insert(chatMembers).values({
        chatId: generalChat.id,
        userId: user.id,
      });
    }

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
