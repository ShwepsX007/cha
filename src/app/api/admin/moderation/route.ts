import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { chats, messages, users } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const rawChatId = request.nextUrl.searchParams.get("chatId");
    const rawSenderId = request.nextUrl.searchParams.get("senderId");
    const chatId = rawChatId && /^\d+$/.test(rawChatId) ? Number(rawChatId) : null;
    const senderId = rawSenderId && /^\d+$/.test(rawSenderId) ? Number(rawSenderId) : null;

    const chatRows = await db
      .select({
        id: chats.id,
        name: chats.name,
        isGroup: chats.isGroup,
        securityMode: chats.securityMode,
        createdAt: chats.createdAt,
      })
      .from(chats)
      .orderBy(desc(chats.createdAt))
      .limit(200);

    const filters = [];
    if (chatId) filters.push(eq(messages.chatId, chatId));
    if (senderId) filters.push(eq(messages.senderId, senderId));

    const messageRows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        chatName: chats.name,
        securityMode: chats.securityMode,
        senderId: messages.senderId,
        senderUsername: users.username,
        senderDisplayName: users.displayName,
        content: messages.content,
        messageType: messages.messageType,
        fileName: messages.fileName,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(messages.createdAt))
      .limit(200);

    return NextResponse.json({ chats: chatRows, messages: messageRows }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Не удалось загрузить данные модерации" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const input = body as { action?: unknown; chatId?: unknown; messageIds?: unknown; senderId?: unknown };

  try {
    if (input.action === "clear_chat") {
      const chatId = Number(input.chatId);
      if (!Number.isSafeInteger(chatId) || chatId <= 0) {
        return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
      }
      const [chat] = await db.select({ id: chats.id, name: chats.name, securityMode: chats.securityMode })
        .from(chats).where(eq(chats.id, chatId));
      if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

      const deleted = await db.delete(messages).where(eq(messages.chatId, chatId)).returning({ id: messages.id });
      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "moderation.clear_chat",
        targetType: "chat",
        targetId: String(chatId),
        details: { name: chat.name, securityMode: chat.securityMode, deletedMessages: deleted.length },
      });
      return NextResponse.json({ success: true, deletedMessages: deleted.length });
    }

    if (input.action === "delete_messages") {
      if (!Array.isArray(input.messageIds) || input.messageIds.length === 0 || input.messageIds.length > 200) {
        return NextResponse.json({ error: "Выберите от 1 до 200 сообщений" }, { status: 400 });
      }
      const messageIds = [...new Set(input.messageIds.map(Number))];
      if (messageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        return NextResponse.json({ error: "Список сообщений содержит некорректный ID" }, { status: 400 });
      }
      const deleted = await db.delete(messages).where(inArray(messages.id, messageIds)).returning({ id: messages.id });
      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "moderation.delete_messages",
        targetType: "message",
        targetId: null,
        details: { requestedCount: messageIds.length, deletedCount: deleted.length, messageIds: deleted.map((message) => message.id) },
      });
      return NextResponse.json({ success: true, deletedMessages: deleted.length });
    }

    if (input.action === "delete_user_messages") {
      const senderId = Number(input.senderId);
      if (!Number.isSafeInteger(senderId) || senderId <= 0) {
        return NextResponse.json({ error: "Некорректный ID пользователя" }, { status: 400 });
      }
      const [sender] = await db.select({ id: users.id, username: users.username })
        .from(users).where(eq(users.id, senderId));
      if (!sender) return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
      const deleted = await db.delete(messages).where(eq(messages.senderId, senderId)).returning({ id: messages.id });
      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "moderation.delete_user_messages",
        targetType: "user",
        targetId: String(senderId),
        details: { username: sender.username, deletedMessages: deleted.length },
      });
      return NextResponse.json({ success: true, deletedMessages: deleted.length });
    }

    return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Не удалось выполнить действие модерации" }, { status: 500 });
  }
}
