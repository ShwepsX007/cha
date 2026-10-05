import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Bot } from "grammy";
import { db } from "../src/db";
import { users, adminAuditLogs, chats, chatMembers } from "../src/db/schema";
import { and, eq, sql } from "drizzle-orm";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const OWNER_ID = Number(process.env.BOT_OWNER_TELEGRAM_ID?.trim() || "");
const DATABASE_URL = process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the Telegram admin bootstrap bot.");
}
if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required for the Telegram admin bootstrap bot.");
}
if (!Number.isFinite(OWNER_ID) || OWNER_ID <= 0) {
  throw new Error("Set BOT_OWNER_TELEGRAM_ID to your numeric Telegram user id. The bot will ignore everyone else.");
}

const ADMIN_USERNAME = "telegram_admin";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function generatePassword(length = 18): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let password = "";
  for (let i = 0; i < length; i += 1) {
    password += alphabet[bytes[i] % alphabet.length];
  }
  return password;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(attempts = 20): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Waiting for PostgreSQL... attempt ${attempt}/${attempts}`);
      await sleep(1000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PostgreSQL is unavailable");
}

async function createOrRotateAdmin(): Promise<{ username: string; password: string; isNewUser: boolean }> {
  await waitForDatabase();
  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(734729105)`);

    const [existing] = await tx
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.username, ADMIN_USERNAME));

    if (existing) {
      await tx
        .update(users)
        .set({
          passwordHash,
          role: "admin",
          bannedUntil: null,
          banReason: null,
          displayName: "Telegram Admin",
          lastSeen: new Date(),
        })
        .where(eq(users.id, existing.id));
      await tx.insert(adminAuditLogs).values({
        adminId: existing.id,
        action: "bot.admin_rotation",
        targetType: "self",
        targetId: String(existing.id),
        details: { source: "telegram-bot", rotatedAt: new Date().toISOString() },
      });
      return { username: ADMIN_USERNAME, password, isNewUser: false };
    }

    const [generalChat] = await tx
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.name, "Общий чат"), eq(chats.isGroup, true)))
      .limit(1);

    const [user] = await tx
      .insert(users)
      .values({
        username: ADMIN_USERNAME,
        displayName: "Telegram Admin",
        passwordHash,
        role: "admin",
      })
      .returning({ id: users.id });

    if (generalChat?.id) {
      const [existingMember] = await tx
        .select({ id: chatMembers.id })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, generalChat.id), eq(chatMembers.userId, user.id)))
        .limit(1);
      if (!existingMember) {
        await tx.insert(chatMembers).values({ chatId: generalChat.id, userId: user.id });
      }
    }

    await tx.insert(adminAuditLogs).values({
      adminId: user.id,
      action: "bot.admin_creation",
      targetType: "self",
      targetId: String(user.id),
      details: { source: "telegram-bot", createdAt: new Date().toISOString() },
    });

    return { username: ADMIN_USERNAME, password, isNewUser: true };
  });
}

const bot = new Bot(BOT_TOKEN);

bot.use((ctx, next) => {
  const telegramId = ctx.from?.id;
  if (telegramId !== OWNER_ID) {
    console.warn(`Ignored non-owner Telegram request from ${telegramId ?? "unknown"}`);
    return undefined;
  }
  return next();
});

bot.command("start", (ctx) => ctx.reply(
  "<b>Админ-бот Secret Chat</b>\n" +
  "Доступ только для владельца по BOT_OWNER_TELEGRAM_ID.\n" +
  "Отправьте /getadmin — создать или пересоздать аккаунт администратора и получить логин/пароль.",
  { parse_mode: "HTML" },
));

bot.command("help", (ctx) => ctx.reply(
  "Команды:\n" +
  "/start — приветствие\n" +
  "/getadmin — создать/сбросить локальный аккаунт админа и получить логин/пароль\n" +
  "/help — это сообщение",
));

bot.command("getadmin", async (ctx) => {
  const statusMessage = await ctx.reply("Создаю/ротирую аккаунт администратора…");
  try {
    const result = await createOrRotateAdmin();
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `<b>${result.isNewUser ? "Админ создан" : "Пароль админа сброшен"}</b>\n\n` +
        `Логин: <code>${escapeHtml(result.username)}</code>\n` +
        `Пароль: <code>${escapeHtml(result.password)}</code>\n\n` +
        "Войдите с этими данными в веб-приложении. Если Общий чат ещё не был создан или аккаунт не был в него добавлен, откройте список чатов после первого входа.",
      { parse_mode: "HTML" },
    );
  } catch (error) {
    console.error("Telegram admin creation failed:", error);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      "Не удалось создать администратора. Проверьте DATABASE_URL и доступ к PostgreSQL в логах бота.",
    );
  }
});

bot.start({
  drop_pending_updates: true,
  onStart: (info) => {
    console.log(`Telegram admin bootstrap bot started as @${info.username}; owner Telegram id ${OWNER_ID}.`);
  },
});
