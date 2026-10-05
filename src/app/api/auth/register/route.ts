import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createToken } from "@/lib/auth";
import { ensureGeneralChatMembership } from "@/lib/chats";
import {
  CAPTCHA_MIN_AGE_MS,
  clientIpFromHeaders,
  consumeCaptchaNonce,
  peekRateBucket,
  pruneExpiredCaptchaNonces,
  rateBucketRetryAfterMs,
  recordRateEvent,
  verifyCaptchaToken,
} from "@/lib/captcha";

// Reserved for the Telegram bootstrap bot: anyone who registers this name
// before the bot runs would appear in the admin panel as the bot account.
const RESERVED_USERNAMES = new Set(["telegram_admin"]);

/** Owner's rule: at most 3 successful registrations per hour from one IP.
 *  REGISTER_MAX_PER_IP=0 disables the quota (smoke tests re-running on the
 *  server all come from 127.0.0.1 and would otherwise lock themselves out). */
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_PER_IP = (() => {
  const parsed = Number.parseInt(process.env.REGISTER_MAX_PER_IP ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
})();

const AVATAR_COLORS = [
  "#6C5CE7", "#A29BFE", "#00B894", "#00CEC9", "#0984E3",
  "#E17055", "#FDCB6E", "#E84393", "#55A3F5", "#FF7675",
];

function captchaFailed(detail: string) {
  return NextResponse.json(
    { error: `Капча не пройдена: ${detail}. Введите новое значение с картинки.`, captchaRequired: true },
    { status: 400 },
  );
}

export async function POST(req: NextRequest) {
  try {
    const { username, password, displayName, captchaToken, captchaAnswer } = await req.json();

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return NextResponse.json({ error: "Логин и пароль обязательны" }, { status: 400 });
    }

    if (username.length < 3 || username.length > 50 || password.length < 4) {
      return NextResponse.json(
        { error: "Логин от 3 до 50 символов, пароль минимум 4" },
        { status: 400 }
      );
    }

    if (RESERVED_USERNAMES.has(username.toLowerCase())) {
      return NextResponse.json(
        { error: "Этот логин зарезервирован для Telegram-админа" },
        { status: 409 },
      );
    }

    // ---- Bot protection: signed single-use captcha + per-IP quota -------
    // Checked before any user-existence lookup so the endpoint cannot be used
    // to enumerate usernames by a client that has not solved the captcha.
    const payload = verifyCaptchaToken(captchaToken);
    if (!payload) return captchaFailed("значение просрочено или подделано");
    if (Date.now() - payload.issuedAt < CAPTCHA_MIN_AGE_MS) {
      await consumeCaptchaNonce(payload.nonce);
      return captchaFailed("ответ отправлен слишком быстро");
    }
    const answer = typeof captchaAnswer === "string" ? captchaAnswer.trim().toUpperCase() : "";
    if (!answer || answer !== payload.code.toUpperCase()) {
      await consumeCaptchaNonce(payload.nonce);
      return captchaFailed("ответ не совпадает");
    }
    // Valid answer: burn the token so the same request cannot be replayed,
    // then look at the per-IP quota (successful registrations only).
    const spent = await consumeCaptchaNonce(payload.nonce);
    if (!spent) return captchaFailed("эта капча уже использована");

    const ip = clientIpFromHeaders(req.headers);
    if (REGISTER_MAX_PER_IP > 0 && peekRateBucket("register-success", ip, REGISTER_WINDOW_MS) >= REGISTER_MAX_PER_IP) {
      const retryMinutes = Math.max(1, Math.ceil(rateBucketRetryAfterMs("register-success", ip, REGISTER_WINDOW_MS) / 60_000));
      return NextResponse.json(
        { error: `С этого IP зарегистрировано максимум ${REGISTER_MAX_PER_IP} аккаунтов в час. Следующая попытка — примерно через ${retryMinutes} мин.` },
        { status: 429 },
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
          displayName:
            typeof displayName === "string" && displayName.trim()
              ? displayName.trim().slice(0, 50)
              : username,
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
      },
    });
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    // The quota counts accounts that were really created, so a user mistyping
    // their password/username cannot lock their own IP out.
    recordRateEvent("register-success", ip, REGISTER_WINDOW_MS);
    void pruneExpiredCaptchaNonces();

    return response;
  } catch (error) {
    console.error("Register error:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
