import { NextRequest, NextResponse } from "next/server";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats, users } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { deleteChatPermanently } from "@/lib/chat-delete";
import { removeAvatarFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Chat management for the admin panel.
 *
 *   GET    /api/admin/chats[?q=]      list with member/message counts, creator,
 *                                     avatar and the general (public) flag
 *   POST   /api/admin/chats           create a chat; isGeneral: true adds every
 *                                     existing user as a member (offline users
 *                                     are auto-joined on their next sync)
 *   PATCH  /api/admin/chats           rename and/or remove the avatar
 *   DELETE /api/admin/chats?chatId=N  hard delete (cascades like the user-side
 *                                     endpoint, but also allowed for general
 *                                     chats, which are re-created empty by
 *                                     ensureGeneralChatMembership)
 *
 * The "general chat" role lives in the is_general flag, so renaming never
 * detaches moderation rules or membership sync.
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
        isGeneral: chats.isGeneral,
        avatarUrl: chats.avatarUrl,
        avatarUpdatedAt: chats.avatarUpdatedAt,
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
      .orderBy(desc(chats.isGeneral), desc(chats.createdAt))
      .limit(200);

    const enriched = rows.map((row) => ({
      ...row,
      memberCount: Number(row.memberCount),
      messageCount: Number(row.messageCount),
      avatarUpdatedAt:
        row.avatarUpdatedAt instanceof Date ? row.avatarUpdatedAt.toISOString() : row.avatarUpdatedAt ?? null,
    }));

    return NextResponse.json({ chats: enriched }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Admin chats list error:", error);
    return NextResponse.json({ error: "Не удалось загрузить список чатов" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const input = body as { name?: unknown; isGeneral?: unknown };
  const name =
    typeof input.name === "string"
      ? input.name.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 100)
      : "";
  if (/<[>|]|&lt;|&gt;|&amp;/.test(name)) {
    return NextResponse.json({ error: "Название не должно содержать HTML-спецсимволы" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "Название обязательно (1–100 символов)" }, { status: 400 });
  }
  const isGeneral = input.isGeneral === true;

  try {
    const result = await db.transaction(async (tx) => {
      const [chat] = await tx
        .insert(chats)
        .values({ name, isGroup: true, isGeneral, createdBy: auth.admin!.id })
        .returning();

      // A public chat is by definition for everyone: join every existing
      // account right away (users registered later join on registration, and
      // /api/chats re-syncs anyone who missed one while offline).
      if (isGeneral) {
        const everyone = await tx.select({ id: users.id }).from(users);
        if (everyone.length > 0) {
          await tx
            .insert(chatMembers)
            .values(everyone.map((row) => ({ chatId: chat.id, userId: row.id })))
            .onConflictDoNothing();
        }
      }
      return chat;
    });

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "chats.create",
      targetType: "chat",
      targetId: String(result.id),
      details: { name, isGeneral },
    });

    return NextResponse.json({ chat: result });
  } catch (error) {
    console.error("Admin chat create error:", error);
    return NextResponse.json({ error: "Не удалось создать чат" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const input = body as { chatId?: unknown; name?: unknown; removeAvatar?: unknown };
  const chatId = Number(input.chatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
  }

  const wantsRename = typeof input.name === "string";
  const wantsAvatarRemoval = input.removeAvatar === true;
  if (!wantsRename && !wantsAvatarRemoval) {
    return NextResponse.json({ error: "Нечего обновить: передайте name или removeAvatar" }, { status: 400 });
  }

  try {
    const [chat] = await db
      .select({ id: chats.id, name: chats.name, avatarUrl: chats.avatarUrl })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    const patch: Partial<{ name: string; avatarUrl: string | null; avatarUpdatedAt: Date }> = {};

    if (wantsRename) {
      const name = input.name as string;
      const cleaned = name.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!cleaned) {
        return NextResponse.json({ error: "Название не может быть пустым" }, { status: 400 });
      }
      if (/<[>|]|&lt;|&gt;|&amp;/.test(cleaned)) {
        return NextResponse.json({ error: "Название не должно содержать HTML-спецсимволы" }, { status: 400 });
      }
      patch.name = cleaned;
    }

    let removedAvatarPath: string | null = null;
    if (wantsAvatarRemoval && chat.avatarUrl) {
      patch.avatarUrl = null;
      patch.avatarUpdatedAt = new Date();
      removedAvatarPath = chat.avatarUrl;
    } else if (wantsAvatarRemoval) {
      patch.avatarUpdatedAt = new Date();
    }

    const [updated] = await db
      .update(chats)
      .set(patch)
      .where(eq(chats.id, chatId))
      .returning({ id: chats.id, name: chats.name, avatarUrl: chats.avatarUrl });

    // The old file goes only after the row points at nothing else; a failure
    // here would just leave an orphan file in UPLOAD_DIR.
    if (removedAvatarPath) await removeAvatarFile(removedAvatarPath);

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: wantsRename ? "chats.rename" : "chats.avatar.remove",
      targetType: "chat",
      targetId: String(chatId),
      details: wantsRename ? { from: chat.name, to: updated?.name } : { previousAvatar: removedAvatarPath },
    });

    return NextResponse.json({ chat: updated });
  } catch (error) {
    console.error("Admin chat update error:", error);
    return NextResponse.json({ error: "Не удалось обновить чат" }, { status: 500 });
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
      .select({ id: chats.id, name: chats.name, isGroup: chats.isGroup, isGeneral: chats.isGeneral })
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
        isGeneral: chat.isGeneral,
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
