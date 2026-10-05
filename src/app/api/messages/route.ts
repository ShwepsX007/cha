import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messages, users, chatMembers, chats } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and, asc, inArray } from "drizzle-orm";
import { getActivePublicChatBan } from "@/lib/moderation";
import { isGeneralChat } from "@/lib/chats";
import { messagePreview, notifyChatMessage } from "@/lib/notifications";
import { deleteMessagePermanently } from "@/lib/chat-delete";

export async function GET(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const chatId = Number(req.nextUrl.searchParams.get("chatId"));
    if (!chatId) {
      return NextResponse.json({ error: "chatId required" }, { status: 400 });
    }

    // Check membership
    const [membership] = await db
      .select()
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId))
      );

    if (!membership) {
      return NextResponse.json({ error: "Not a member" }, { status: 403 });
    }

    // Do not treat a background tab's polling as active presence: that would
    // suppress push notifications indefinitely while the app is merely open
    // in another tab. Older clients without the header retain the old behavior.
    if (req.headers.get("x-chat-visible") !== "0") {
      await db.update(users).set({ lastSeen: new Date() }).where(eq(users.id, payload.userId));
    }

    const msgs = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        content: messages.content,
        messageType: messages.messageType,
        replyToMessageId: messages.replyToMessageId,
        telegramFileId: messages.telegramFileId,
        fileName: messages.fileName,
        fileSize: messages.fileSize,
        mimeType: messages.mimeType,
        createdAt: messages.createdAt,
        senderUsername: users.username,
        senderDisplayName: users.displayName,
        senderAvatarColor: users.avatarColor,
        senderAvatarUrl: users.avatarUrl,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt));

    const referencedIds = [...new Set(
      msgs.map((message) => message.replyToMessageId).filter((id): id is number => typeof id === "number"),
    )];
    const replyMessages = referencedIds.length
      ? await db
          .select({
            id: messages.id,
            senderId: messages.senderId,
            content: messages.content,
            messageType: messages.messageType,
            fileName: messages.fileName,
            senderUsername: users.username,
            senderDisplayName: users.displayName,
          })
          .from(messages)
          .innerJoin(users, eq(messages.senderId, users.id))
          .where(inArray(messages.id, referencedIds))
      : [];
    const replyById = new Map(replyMessages.map((message) => [message.id, message]));

    return NextResponse.json({
      messages: msgs.map((message) => ({
        ...message,
        replyTo: message.replyToMessageId ? replyById.get(message.replyToMessageId) || null : null,
      })),
    });
  } catch (error) {
    console.error("Messages error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: unknown = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    }
    const input = body as { chatId?: unknown; content?: unknown; replyToMessageId?: unknown };
    const chatId = Number(input.chatId);
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!Number.isInteger(chatId) || chatId <= 0 || !content) {
      return NextResponse.json({ error: "chatId and content required" }, { status: 400 });
    }

    const [membership] = await db
      .select()
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId))
      );

    if (!membership) {
      return NextResponse.json({ error: "Not a member" }, { status: 403 });
    }

    const [chat] = await db
      .select({ name: chats.name, isGroup: chats.isGroup })
      .from(chats)
      .where(eq(chats.id, chatId));

    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    let replyToMessageId: number | null = null;
    if (input.replyToMessageId !== undefined && input.replyToMessageId !== null) {
      const requestedReplyId = Number(input.replyToMessageId);
      if (!Number.isInteger(requestedReplyId) || requestedReplyId <= 0) {
        return NextResponse.json({ error: "Invalid reply target" }, { status: 400 });
      }
      const [target] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, requestedReplyId), eq(messages.chatId, chatId)))
        .limit(1);
      if (!target) return NextResponse.json({ error: "Reply target not found in this chat" }, { status: 404 });
      replyToMessageId = target.id;
    }

    // The "public chat ban" is moderation for the open general chat; it must
    // not silence DMs or private groups, which never relied on it.
    if (isGeneralChat(chat)) {
      const activeBan = await getActivePublicChatBan(payload.userId);
      if (activeBan) {
        return NextResponse.json(
          {
            error: `Отправка в общий чат заблокирована до ${activeBan.bannedUntil.toISOString()}`,
            bannedUntil: activeBan.bannedUntil.toISOString(),
            banReason: activeBan.banReason,
          },
          { status: 403 },
        );
      }
    }

    const [msg] = await db
      .insert(messages)
      .values({
        chatId,
        senderId: payload.userId,
        content,
        messageType: "text",
        replyToMessageId,
      })
      .returning();

    const [sender] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, payload.userId));

    // Await the best-effort fan-out so serverless runtimes don't freeze the
    // invocation before message notifications are handed to Web Push.
    await notifyChatMessage({
      chatId,
      senderId: payload.userId,
      senderName: sender?.displayName || "Пользователь",
      textPreview: messagePreview("text", content.trim(), null),
      messageId: msg.id,
    });

    return NextResponse.json({ message: msg });
  } catch (error) {
    console.error("Send message error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/**
 * Delete one's own message for everybody: DELETE /api/messages?messageId=N.
 * (A dedicated /api/messages/[messageId] folder is impossible: sibling
 * [chatId]/receipts pins the dynamic segment name.) Hard delete — the
 * Telegram attachment is removed best-effort, receipts cascade, replies keep
 * their text and lose the jump (FK is ON DELETE SET NULL). Admins moderate
 * foreign messages through the admin panel; this endpoint is author-only.
 */
export async function DELETE(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawId = req.nextUrl.searchParams.get("messageId") ?? "";
    if (!/^\d+$/.test(rawId)) {
      return NextResponse.json({ error: "Некорректный ID сообщения" }, { status: 400 });
    }
    const messageId = Number(rawId);

    const [message] = await db
      .select({ id: messages.id, senderId: messages.senderId, chatId: messages.chatId })
      .from(messages)
      .where(eq(messages.id, messageId));

    // Two tabs / a deleted chat / an admin moderation action may have removed
    // it first: report success (idempotently) instead of a scary error.
    if (!message) return NextResponse.json({ success: true, deleted: false, alreadyGone: true });

    if (message.senderId !== payload.userId) {
      return NextResponse.json({ error: "Удалить сообщение может только его автор" }, { status: 403 });
    }

    // The author must still be a member: once removed from the chat, their old
    // messages are out of reach and only admin moderation can clean them up.
    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, message.chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) {
      return NextResponse.json({ error: "Вы больше не участник этого чата" }, { status: 403 });
    }

    const deleted = await deleteMessagePermanently(message.id);
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error("Delete message error:", error);
    return NextResponse.json({ error: "Не удалось удалить сообщение" }, { status: 500 });
  }
}
