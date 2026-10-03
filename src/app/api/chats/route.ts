import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chats, chatMembers, users, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and, desc, inArray, sql } from "drizzle-orm";

export async function GET() {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get chat IDs where user is a member
    const memberRows = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, payload.userId));

    const chatIds = memberRows.map((r) => r.chatId);
    if (chatIds.length === 0) {
      return NextResponse.json({ chats: [] });
    }

    const chatList = await db
      .select()
      .from(chats)
      .where(inArray(chats.id, chatIds));

    // For each chat, get members and last message
    const result = await Promise.all(
      chatList.map(async (chat) => {
        const members = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarColor: users.avatarColor,
            lastSeen: users.lastSeen,
          })
          .from(chatMembers)
          .innerJoin(users, eq(chatMembers.userId, users.id))
          .where(eq(chatMembers.chatId, chat.id));

        const [lastMessage] = await db
          .select({
            id: messages.id,
            content: messages.content,
            messageType: messages.messageType,
            fileName: messages.fileName,
            senderId: messages.senderId,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.chatId, chat.id))
          .orderBy(desc(messages.createdAt))
          .limit(1);

        // For private chats, use the other user's name
        let chatName = chat.name;
        if (!chat.isGroup) {
          const otherUser = members.find((m) => m.id !== payload.userId);
          chatName = otherUser?.displayName || "Чат";
        }

        const unreadCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(eq(messages.chatId, chat.id));

        return {
          ...chat,
          name: chatName,
          members,
          lastMessage: lastMessage || null,
          messageCount: Number(unreadCount[0]?.count || 0),
        };
      })
    );

    // Sort by last message time
    result.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt?.getTime() || 0;
      const bTime = b.lastMessage?.createdAt?.getTime() || 0;
      return bTime - aTime;
    });

    return NextResponse.json({ chats: result });
  } catch (error) {
    console.error("Chats error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { targetUserId, name, isGroup } = await req.json();

    if (!isGroup && targetUserId) {
      // Check if private chat already exists between these two users
      const myChats = await db
        .select({ chatId: chatMembers.chatId })
        .from(chatMembers)
        .where(eq(chatMembers.userId, payload.userId));
      
      const myChatIds = myChats.map((r) => r.chatId);
      
      if (myChatIds.length > 0) {
        const theirChats = await db
          .select({ chatId: chatMembers.chatId })
          .from(chatMembers)
          .where(
            and(
              eq(chatMembers.userId, targetUserId),
              inArray(chatMembers.chatId, myChatIds)
            )
          );

        for (const tc of theirChats) {
          const [existingChat] = await db
            .select()
            .from(chats)
            .where(and(eq(chats.id, tc.chatId), eq(chats.isGroup, false)));
          if (existingChat) {
            return NextResponse.json({ chat: existingChat, existing: true });
          }
        }
      }
    }

    const [chat] = await db
      .insert(chats)
      .values({
        name: name || null,
        isGroup: isGroup || false,
        createdBy: payload.userId,
      })
      .returning();

    // Add creator as member
    await db.insert(chatMembers).values({
      chatId: chat.id,
      userId: payload.userId,
    });

    // Add target user for private chat
    if (targetUserId) {
      await db.insert(chatMembers).values({
        chatId: chat.id,
        userId: targetUserId,
      });
    }

    return NextResponse.json({ chat });
  } catch (error) {
    console.error("Create chat error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
