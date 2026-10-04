import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messages, users, chatMembers, chats } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and, asc } from "drizzle-orm";

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

    const msgs = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        content: messages.content,
        messageType: messages.messageType,
        telegramFileId: messages.telegramFileId,
        fileName: messages.fileName,
        fileSize: messages.fileSize,
        mimeType: messages.mimeType,
        createdAt: messages.createdAt,
        senderUsername: users.username,
        senderDisplayName: users.displayName,
        senderAvatarColor: users.avatarColor,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt));

    return NextResponse.json({ messages: msgs });
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

    const { chatId, content } = await req.json();
    if (!chatId || !content?.trim()) {
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
      .select({ securityMode: chats.securityMode })
      .from(chats)
      .where(eq(chats.id, chatId));

    if (!chat || chat.securityMode !== "public") {
      return NextResponse.json(
        { error: "Private messages must use the encrypted Matrix room", code: "E2EE_REQUIRED" },
        { status: 409 },
      );
    }

    const [msg] = await db
      .insert(messages)
      .values({
        chatId,
        senderId: payload.userId,
        content: content.trim(),
        messageType: "text",
      })
      .returning();

    return NextResponse.json({ message: msg });
  } catch (error) {
    console.error("Send message error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
