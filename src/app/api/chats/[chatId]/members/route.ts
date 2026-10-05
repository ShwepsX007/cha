import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

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

    if (!Number.isInteger(chatId) || chatId <= 0 || !Number.isInteger(targetUserId) || targetUserId <= 0) {
      return NextResponse.json({ error: "Invalid chat or user ID" }, { status: 400 });
    }

    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
    if (!chat || !chat.isGroup) {
      return NextResponse.json({ error: "Group chat not found" }, { status: 404 });
    }

    // Only a group member may add others, and only the creator (or an app
    // admin) grows the group.
    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) {
      return NextResponse.json({ error: "Not a group member" }, { status: 403 });
    }
    if (chat.createdBy !== payload.userId) {
      const [requester] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, payload.userId));
      if (requester?.role !== "admin") {
        return NextResponse.json({ error: "Только создатель группы или администратор может добавлять участников" }, { status: 403 });
      }
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

    await db.insert(chatMembers).values({ chatId, userId: target.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Add group member error:", error);
    return NextResponse.json({ error: "Не удалось добавить участника в группу" }, { status: 500 });
  }
}
