import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createToken } from "@/lib/auth";
import { createMatrixSession, type MatrixLoginResult } from "@/lib/matrix/server";
import { ensureConfiguredInitialAdmin } from "@/lib/admin";

export async function POST(req: NextRequest) {
  try {
    const { username, password, matrixDeviceId } = await req.json();

    if (!username || !password) {
      return NextResponse.json({ error: "Логин и пароль обязательны" }, { status: 400 });
    }

    const [user] = await db.select().from(users).where(eq(users.username, username));
    if (!user) {
      return NextResponse.json({ error: "Неверный логин или пароль" }, { status: 401 });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Неверный логин или пароль" }, { status: 401 });
    }

    await ensureConfiguredInitialAdmin(user.id, user.username);
    const [accountState] = await db
      .select({
        role: users.role,
        bannedUntil: users.bannedUntil,
        banReason: users.banReason,
        matrixResetRequired: users.matrixResetRequired,
      })
      .from(users)
      .where(eq(users.id, user.id));
    await db.update(users).set({ lastSeen: new Date() }).where(eq(users.id, user.id));

    let matrix: MatrixLoginResult = { availability: "unavailable", session: null };
    if (!accountState?.matrixResetRequired) {
      try {
        matrix = await createMatrixSession({
          appUserId: user.id,
          username: user.username,
          displayName: user.displayName,
          password,
          deviceId: matrixDeviceId,
        });
      } catch (error) {
        // Matrix downtime must not prevent access to the existing public chat.
        console.error("Matrix session unavailable:", error);
      }
    }

    const token = await createToken(user.id, user.username);
    const response = NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: accountState?.role || "user",
        bannedUntil: accountState?.bannedUntil || null,
        banReason: accountState?.banReason || null,
        matrixResetRequired: accountState?.matrixResetRequired || false,
      },
      matrixAvailability: accountState?.matrixResetRequired ? "unavailable" : matrix.availability,
      matrixSession: matrix.session,
      matrixResetRequired: accountState?.matrixResetRequired || false,
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
    console.error("Login error:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
