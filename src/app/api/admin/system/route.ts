import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, chats, messages, pushSubscriptions, users } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { ensureGeneralChatMembership } from "@/lib/chats";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const [chatCount] = await db.select({ count: sql<number>`count(*)` }).from(chats);
    const [messageCount] = await db.select({ count: sql<number>`count(*)` }).from(messages);
    const [auditCount] = await db.select({ count: sql<number>`count(*)` }).from(adminAuditLogs);
    return NextResponse.json({
      counts: {
        users: Number(userCount?.count || 0),
        chats: Number(chatCount?.count || 0),
        messages: Number(messageCount?.count || 0),
        auditLogs: Number(auditCount?.count || 0),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Не удалось загрузить состояние системы" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const input = body as { action?: unknown; confirmation?: unknown };

  if (input.action === "nuclear_wipe") {
    if (input.confirmation !== "УДАЛИТЬ ВСЁ") {
      return NextResponse.json({ error: "Для подтверждения введите точную фразу: УДАЛИТЬ ВСЁ" }, { status: 400 });
    }

    try {
      const otherAccounts = await db.select({ id: users.id, username: users.username })
        .from(users).where(ne(users.id, auth.admin.id));

      const summary = await db.transaction(async (tx) => {
        const [oldMessageCount] = await tx.select({ count: sql<number>`count(*)` }).from(messages);
        const [oldChatCount] = await tx.select({ count: sql<number>`count(*)` }).from(chats);
        const [oldUserCount] = await tx.select({ count: sql<number>`count(*)` }).from(users).where(ne(users.id, auth.admin.id));

        // Chats cascade to members/messages/receipts; push subscriptions of the
        // deleted accounts go with them.
        await tx.delete(chats);
        if (otherAccounts.length > 0) {
          await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.userId, otherAccounts.map((account) => account.id)));
        }
        await tx.delete(users).where(ne(users.id, auth.admin.id));
        await tx.update(users).set({
          role: "admin",
          bannedUntil: null,
          banReason: null,
        }).where(eq(users.id, auth.admin.id));
        await tx.insert(adminAuditLogs).values({
          adminId: auth.admin.id,
          action: "system.nuclear_wipe",
          targetType: "system",
          details: {
            deletedUsers: Number(oldUserCount?.count || 0),
            deletedChats: Number(oldChatCount?.count || 0),
            deletedMessages: Number(oldMessageCount?.count || 0),
          },
        });

        return {
          deletedUsers: Number(oldUserCount?.count || 0),
          deletedChats: Number(oldChatCount?.count || 0),
          deletedMessages: Number(oldMessageCount?.count || 0),
        };
      });

      // Recreate the general chat for the surviving admin immediately so the
      // app never boots into an empty sidebar after a wipe.
      await ensureGeneralChatMembership(auth.admin.id);

      return NextResponse.json({ success: true, ...summary });
    } catch {
      return NextResponse.json({ error: "Nuclear wipe не завершён; проверьте соединение с PostgreSQL и журнал аудита" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
}
