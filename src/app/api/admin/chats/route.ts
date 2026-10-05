import { NextRequest, NextResponse } from "next/server";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { chats, users } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { deleteChatPermanently } from "@/lib/chat-delete";
import { GENERAL_CHAT_NAME } from "@/lib/chats";

export const dynamic = "force-dynamic";

/**
 * Chat management for the admin panel: list everything that exists (with
 * member/message counts and the creator), and delete a whole chat. Deleting
 * is hard and cascades exactly like the user-facing DELETE /api/chats/[id],
 * but an admin is not bound by the creator check and may remove even the
 * general chat (it is re-created for members on their next sync — so the
 * history, not the container, is what this actually destroys).
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 100) || "";
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const numericId = /^\d+$/.test(query) ? Number(query) : null;
    const where = query
      ? or(
          ilike(chats.name, `%${escaped}%`),
          ...(numericId && Number.isSafeInteger(numericId) ? [eq(chats.id, numericId)] : []),
        )
      : undefined;

    const rows = await db
      .select({
        id: chats.id,
        name: chats.name,
        isGroup: chats.isGroup,
        createdAt: chats.createdAt,
        createdBy: chats.createdBy,
        creatorUsername: users.username,
        creatorDisplayName: users.displayName,
        memberCount: sql<number>`(select count(*) from chat_members where chat_members.chat_id = ${chats.id})`,
        messageCount: sql<number>`(select count(*) from messages where messages.chat_id = ${chats.id})`,
      })
      .from(chats)
      .leftJoin(users, eq(users.id, chats.createdBy))
      .where(where)
      .orderBy(desc(chats.createdAt))
      .limit(200);

    const enriched = rows.map((row) => ({
      ...row,
      memberCount: Number(row.memberCount),
      messageCount: Number(row.messageCount),
      isGeneralChat: row.isGroup && row.name === GENERAL_CHAT_NAME,
    }));

    return NextResponse.json({ chats: enriched }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Admin chats list error:", error);
    return NextResponse.json({ error: "Не удалось загрузить список чатов" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const rawChatId = request.nextUrl.searchParams.get("chatId") ?? "";
  if (!/^\d+$/.test(rawChatId)) {
    return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
  }
  const chatId = Number(rawChatId);

  try {
    const [chat] = await db
      .select({ id: chats.id, name: chats.name, isGroup: chats.isGroup })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    const result = await deleteChatPermanently(chatId);
    if (!result) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "chats.delete",
      targetType: "chat",
      targetId: String(chatId),
      details: {
        name: chat.name,
        isGroup: chat.isGroup,
        deletedMessages: result.deletedMessages,
        telegramAttachmentsRemoved: result.telegramRemoved,
      },
    });

    return NextResponse.json({ success: true, deletedMessages: result.deletedMessages });
  } catch (error) {
    console.error("Admin chat delete error:", error);
    return NextResponse.json({ error: "Не удалось удалить чат" }, { status: 500 });
  }
}
