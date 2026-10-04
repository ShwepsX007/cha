import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import {
  ensureMatrixIdentity,
  inviteMatrixUserToRoom,
  verifyEncryptedRoom,
} from "@/lib/matrix/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const chatId = Number((await params).chatId);
    const body = await req.json();
    const targetUserId = Number(body.userId);
    const matrixAccessToken = typeof body.matrixAccessToken === "string" ? body.matrixAccessToken : "";

    if (!Number.isInteger(chatId) || chatId <= 0 || !Number.isInteger(targetUserId) || targetUserId <= 0) {
      return NextResponse.json({ error: "Invalid chat or user ID" }, { status: 400 });
    }

    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
    if (!chat || !chat.isGroup || chat.securityMode !== "e2ee" || !chat.matrixRoomId || !chat.createdBy) {
      return NextResponse.json({ error: "Encrypted private group not found" }, { status: 404 });
    }

    // Membership in PostgreSQL alone is not enough: the Matrix power levels
    // below independently decide whether this creator/admin may invite.
    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) {
      return NextResponse.json({ error: "Not a group member" }, { status: 403 });
    }

    const [target] = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const [existingMembership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, targetUserId)));
    if (existingMembership) {
      return NextResponse.json({ error: "User is already in this group" }, { status: 409 });
    }

    const currentMembers = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId));
    const currentMemberIds = currentMembers.map((member) => member.userId);

    try {
      await verifyEncryptedRoom({
        roomId: chat.matrixRoomId,
        accessToken: matrixAccessToken,
        appUserIds: currentMemberIds,
        authenticatedAppUserId: payload.userId,
        creatorAppUserId: chat.createdBy,
        expectedHistoryVisibility: "joined",
      });
    } catch {
      return NextResponse.json({ error: "Добавлять участников может только Matrix-создатель/администратор" }, { status: 403 });
    }

    await ensureMatrixIdentity(target.id, target.displayName);
    await inviteMatrixUserToRoom(chat.matrixRoomId, matrixAccessToken, target.id);

    await verifyEncryptedRoom({
      roomId: chat.matrixRoomId,
      accessToken: matrixAccessToken,
      appUserIds: [...currentMemberIds, target.id],
      authenticatedAppUserId: payload.userId,
      creatorAppUserId: chat.createdBy,
      expectedHistoryVisibility: "joined",
    });

    await db.insert(chatMembers).values({ chatId, userId: target.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Add group member error:", error);
    return NextResponse.json({ error: "Не удалось добавить участника в E2EE-группу" }, { status: 500 });
  }
}
