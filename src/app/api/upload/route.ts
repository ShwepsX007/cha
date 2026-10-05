import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messages, chatMembers, chats, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { MAX_TELEGRAM_DOWNLOAD_BYTES, uploadFileToTelegram } from "@/lib/telegram";
import { getActivePublicChatBan } from "@/lib/moderation";
import { isGeneralChat } from "@/lib/chats";
import { messagePreview, notifyChatMessage } from "@/lib/notifications";

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const chatId = Number(formData.get("chatId"));
    const rawReplyToMessageId = formData.get("replyToMessageId");
    const replyToMessageId = rawReplyToMessageId === null || rawReplyToMessageId === ""
      ? null
      : Number(rawReplyToMessageId);

    if (
      !(file instanceof File) || !Number.isInteger(chatId) || chatId <= 0 ||
      (replyToMessageId !== null && (!Number.isInteger(replyToMessageId) || replyToMessageId <= 0))
    ) {
      return NextResponse.json({ error: "file and chatId required" }, { status: 400 });
    }

    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
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

    if (replyToMessageId !== null) {
      const [target] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, replyToMessageId), eq(messages.chatId, chatId)))
        .limit(1);
      if (!target) return NextResponse.json({ error: "Reply target not found in this chat" }, { status: 404 });
    }

    // The "public chat ban" only applies to the open general chat.
    if (isGeneralChat(chat)) {
      const activeBan = await getActivePublicChatBan(payload.userId);
      if (activeBan) {
        return NextResponse.json(
          {
            error: `Загрузка в общий чат заблокирована до ${activeBan.bannedUntil.toISOString()}`,
            bannedUntil: activeBan.bannedUntil.toISOString(),
            banReason: activeBan.banReason,
          },
          { status: 403 },
        );
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      return NextResponse.json({ error: `Файл слишком большой: лимит ${Math.round(MAX_TELEGRAM_DOWNLOAD_BYTES / 1024 / 1024)} МБ` }, { status: 413 });
    }
    const mimeType = file.type || "application/octet-stream";
    const fileName = file.name;
    let messageType = "file";
    if (mimeType.startsWith("image/")) messageType = "image";
    else if (mimeType.startsWith("video/")) messageType = "video";
    else if (mimeType.startsWith("audio/") || mimeType === "application/ogg" || mimeType.startsWith("voice/")) messageType = "file";

    const telegramResult = await uploadFileToTelegram(buffer, fileName, mimeType);
    const [msg] = await db
      .insert(messages)
      .values({
        chatId,
        senderId: payload.userId,
        content: fileName,
        messageType,
        replyToMessageId,
        telegramFileId: telegramResult?.fileId || null,
        telegramMessageId: telegramResult?.messageId ?? null,
        fileName,
        fileSize: telegramResult?.fileSize || buffer.length,
        mimeType,
      })
      .returning();

    const [sender] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, payload.userId));

    await notifyChatMessage({
      chatId,
      senderId: payload.userId,
      senderName: sender?.displayName || "Пользователь",
      textPreview: messagePreview(messageType, fileName, fileName),
      messageId: msg.id,
    });

    return NextResponse.json({ message: msg, uploaded: !!telegramResult });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
