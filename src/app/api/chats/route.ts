import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chats, chatMembers, users, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { verifyEncryptedRoom } from "@/lib/matrix/server";
import { eq, and, desc, inArray, sql } from "drizzle-orm";

export async function GET() {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    const result = await Promise.all(
      chatList.map(async (chat) => {
        const members = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarColor: users.avatarColor,
            avatarUrl: users.avatarUrl,
            avatarUpdatedAt: users.avatarUpdatedAt,
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
            senderDisplayName: users.displayName,
            senderAvatarColor: users.avatarColor,
            senderAvatarUrl: users.avatarUrl,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(users, eq(messages.senderId, users.id))
          .where(eq(messages.chatId, chat.id))
          .orderBy(desc(messages.createdAt))
          .limit(1);

        let chatName = chat.name;
        if (!chat.isGroup) {
          const otherUser = members.find((m) => m.id !== payload.userId);
          chatName = otherUser?.displayName || "Чат";
        }

        const messageCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(eq(messages.chatId, chat.id));

        return {
          ...chat,
          name: chatName,
          members,
          lastMessage: lastMessage || null,
          messageCount: Number(messageCount[0]?.count || 0),
        };
      }),
    );

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

    const body = await req.json();
    const isGroup = body.isGroup === true;
    const rawMemberIds: unknown[] = isGroup
      ? Array.isArray(body.memberUserIds) ? body.memberUserIds : []
      : [body.targetUserId];
    const memberUserIds = [...new Set(rawMemberIds.map(Number))];
    const matrixRoomId = typeof body.matrixRoomId === "string" ? body.matrixRoomId : "";
    const matrixAccessToken = typeof body.matrixAccessToken === "string" ? body.matrixAccessToken : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";

    if (
      memberUserIds.length === 0 ||
      (isGroup && memberUserIds.length < 2) ||
      memberUserIds.some((id) => !Number.isInteger(id) || id <= 0 || id === payload.userId)
    ) {
      return NextResponse.json(
        { error: isGroup ? "Выберите как минимум двух участников группы" : "A valid other user is required" },
        { status: 400 },
      );
    }

    const targetUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, memberUserIds));
    if (targetUsers.length !== memberUserIds.length) {
      return NextResponse.json({ error: "One or more users were not found" }, { status: 404 });
    }

    let existingChat: typeof chats.$inferSelect | undefined;
    if (!isGroup) {
      const myRows = await db
        .select({ chatId: chatMembers.chatId })
        .from(chatMembers)
        .where(eq(chatMembers.userId, payload.userId));
      const myChatIds = myRows.map((row) => row.chatId);

      if (myChatIds.length > 0) {
        const sharedRows = await db
          .select({ chatId: chatMembers.chatId })
          .from(chatMembers)
          .where(
            and(
              eq(chatMembers.userId, memberUserIds[0]),
              inArray(chatMembers.chatId, myChatIds),
            ),
          );
        for (const shared of sharedRows) {
          const [candidate] = await db
            .select()
            .from(chats)
            .where(and(eq(chats.id, shared.chatId), eq(chats.isGroup, false)));
          if (candidate) {
            existingChat = candidate;
            break;
          }
        }
      }
    }

    if (existingChat?.securityMode === "e2ee" && existingChat.matrixRoomId) {
      return NextResponse.json({ chat: existingChat, existing: true });
    }

    // Do not create a plaintext private room. The first request tells the
    // browser to create a Matrix room; the second request verifies and links it.
    if (!matrixRoomId || !matrixAccessToken) {
      return NextResponse.json({
        chat: existingChat || null,
        existing: Boolean(existingChat),
        requiresEncryptedRoom: true,
      });
    }

    try {
      await verifyEncryptedRoom({
        roomId: matrixRoomId,
        accessToken: matrixAccessToken,
        appUserIds: [payload.userId, ...memberUserIds],
        authenticatedAppUserId: payload.userId,
        creatorAppUserId: payload.userId,
        expectedHistoryVisibility: isGroup ? "joined" : "invited",
      });
    } catch (error) {
      console.warn("Rejected unverified Matrix room for app chat:", error);
      return NextResponse.json(
        { error: "Не удалось подтвердить, что комната Matrix приватная и зашифрованная" },
        { status: 400 },
      );
    }

    if (existingChat) {
      const [chat] = await db
        .update(chats)
        .set({
          securityMode: "e2ee",
          matrixRoomId,
          e2eeEnabledAt: new Date(),
        })
        .where(eq(chats.id, existingChat.id))
        .returning();
      return NextResponse.json({ chat, existing: true, upgraded: true });
    }

    const [chat] = await db
      .insert(chats)
      .values({
        name: isGroup ? (name || "Приватная группа") : null,
        isGroup,
        createdBy: payload.userId,
        securityMode: "e2ee",
        matrixRoomId,
        e2eeEnabledAt: new Date(),
      })
      .returning();

    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: payload.userId },
      ...memberUserIds.map((userId) => ({ chatId: chat.id, userId })),
    ]);

    return NextResponse.json({ chat, existing: false });
  } catch (error) {
    console.error("Create chat error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
