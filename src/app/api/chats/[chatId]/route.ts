import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { chatDeleteGuard, deleteChatPermanently } from "@/lib/chat-delete";
import { resolveChatEditAccess } from "@/lib/chat-manage";
import { validateChatName } from "@/lib/chats";

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}

/**
 * Rename a group the caller created (admins: any group). Only the display
 * name changes — membership, history and the general-chat flag are
 * untouched, and the chat keeps its moderation rules because the flag, not
 * the name, defines them.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const chatId = Number((await params).chatId);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
    }

    const access = await resolveChatEditAccess(chatId, payload.userId);
    if (!access.ok) return access.response;

    const body: unknown = await req.json().catch(() => null);
    const validated = validateChatName((body as { name?: unknown } | null)?.name);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const [updated] = await db
      .update(chats)
      .set({ name: validated.name })
      .where(eq(chats.id, chatId))
      .returning({ id: chats.id, name: chats.name });

    return NextResponse.json({ chat: updated });
  } catch (error) {
    console.error("Rename chat error:", error);
    return NextResponse.json({ error: "Не удалось переименовать чат" }, { status: 500 });
  }
}

/**
 * Delete a chat the caller created: group or direct. Everything it contains
 * (members, messages, receipts, Telegram attachments) goes with it — this is
 * a hard delete for all participants, matching "remove the group I made".
 * The public general chat cannot be deleted here (it is recreated for members
 * by design); admins can still remove it from the panel.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const chatId = Number((await params).chatId);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
    }

    const [chat] = await db
      .select({
        id: chats.id,
        name: chats.name,
        isGroup: chats.isGroup,
        isGeneral: chats.isGeneral,
        createdBy: chats.createdBy,
      })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    const [requester] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, payload.userId));
    const isAdmin = requester?.role === "admin";

    if (!isAdmin) {
      if (chat.createdBy !== payload.userId) {
        return NextResponse.json({ error: "Удалить чат может только его создатель" }, { status: 403 });
      }
      const guard = chatDeleteGuard(chat);
      if (guard) return NextResponse.json({ error: guard }, { status: 403 });
    }

    // Membership check is skipped for admins: they moderate chats they are not
    // part of. Regular users can only fire this at their own chat anyway.
    if (!isAdmin) {
      const [membership] = await db
        .select({ id: chatMembers.id })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
      if (!membership) return NextResponse.json({ error: "Not a member" }, { status: 403 });
    }

    const result = await deleteChatPermanently(chatId);
    if (!result) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    return NextResponse.json({ success: true, deletedMessages: result.deletedMessages });
  } catch (error) {
    console.error("Delete chat error:", error);
    return NextResponse.json({ error: "Не удалось удалить чат" }, { status: 500 });
  }
}
