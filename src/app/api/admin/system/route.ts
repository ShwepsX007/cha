import { NextRequest, NextResponse } from "next/server";
import { eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, chats, messages, users } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { deactivateMatrixIdentityForAppUser, getMatrixHealthStatus, resetMatrixDevicesForAppUser } from "@/lib/matrix/server";

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
      matrixStatus: await getMatrixHealthStatus(),
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

  if (input.action === "mass_matrix_reset") {
    try {
      const accounts = await db.select({ id: users.id }).from(users);
      await db.update(users).set({ matrixResetRequired: true });

      let configuredAccounts = 0;
      let resetCount = 0;
      let failedCount = 0;
      for (const account of accounts) {
        try {
          const result = await resetMatrixDevicesForAppUser(account.id);
          if (result.configured) {
            configuredAccounts += 1;
            resetCount += result.revokedDevices;
          }
        } catch {
          failedCount += 1;
        }
      }

      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "system.mass_matrix_reset",
        targetType: "system",
        targetId: null,
        details: { accountsFlagged: accounts.length, configuredAccounts, revokedDevices: resetCount, failedAccounts: failedCount },
      });
      return NextResponse.json({
        success: true,
        accountsFlagged: accounts.length,
        configuredAccounts,
        revokedDevices: resetCount,
        failedAccounts: failedCount,
        warning: failedCount ? "Для части аккаунтов Synapse не подтвердил сброс; флаги сброса сохранены." : null,
      }, { status: failedCount ? 202 : 200 });
    } catch {
      return NextResponse.json({ error: "Не удалось выполнить массовый Matrix-сброс" }, { status: 500 });
    }
  }

  if (input.action === "nuclear_wipe") {
    if (input.confirmation !== "УДАЛИТЬ ВСЁ") {
      return NextResponse.json({ error: "Для подтверждения введите точную фразу: УДАЛИТЬ ВСЁ" }, { status: 400 });
    }

    try {
      const otherAccounts = await db.select({ id: users.id, username: users.username })
        .from(users).where(ne(users.id, auth.admin.id));
      let matrixAccountsDeactivated = 0;
      let matrixAccountsUnconfigured = 0;
      let deactivationFailed = 0;

      for (const account of otherAccounts) {
        try {
          const result = await deactivateMatrixIdentityForAppUser(account.id);
          if (result.configured) matrixAccountsDeactivated += 1;
          else matrixAccountsUnconfigured += 1;
        } catch {
          deactivationFailed += 1;
        }
      }

      if (deactivationFailed > 0) {
        await writeAdminAuditLog({
          adminId: auth.admin.id,
          action: "system.nuclear_wipe_failed",
          targetType: "system",
          targetId: null,
          details: {
            accountsRequested: otherAccounts.length,
            matrixAccountsDeactivated,
            matrixAccountsUnconfigured,
            deactivationFailed,
            postgresWipeCompleted: false,
          },
        });
        return NextResponse.json({
          error: "Synapse не подтвердил деактивацию всех аккаунтов. PostgreSQL не очищена; часть Matrix-аккаунтов могла быть деактивирована.",
          matrixAccountsDeactivated,
          deactivationFailed,
        }, { status: 502 });
      }

      const summary = await db.transaction(async (tx) => {
        const [oldMessageCount] = await tx.select({ count: sql<number>`count(*)` }).from(messages);
        const [oldChatCount] = await tx.select({ count: sql<number>`count(*)` }).from(chats);
        const [oldUserCount] = await tx.select({ count: sql<number>`count(*)` }).from(users).where(ne(users.id, auth.admin.id));

        await tx.delete(chats);
        await tx.delete(users).where(ne(users.id, auth.admin.id));
        await tx.update(users).set({
          role: "admin",
          bannedUntil: null,
          banReason: null,
          matrixResetRequired: false,
          matrixRecoveryKeyEncrypted: null,
          matrixRecoveryKeySalt: null,
        }).where(eq(users.id, auth.admin.id));
        await tx.insert(adminAuditLogs).values({
          adminId: auth.admin.id,
          action: "system.nuclear_wipe",
          targetType: "system",
          details: {
            deletedUsers: Number(oldUserCount?.count || 0),
            deletedChats: Number(oldChatCount?.count || 0),
            deletedMessages: Number(oldMessageCount?.count || 0),
            matrixAccountsDeactivated,
            matrixAccountsUnconfigured,
            matrixRoomHistoryAffected: false,
          },
        });

        return {
          deletedUsers: Number(oldUserCount?.count || 0),
          deletedChats: Number(oldChatCount?.count || 0),
          deletedMessages: Number(oldMessageCount?.count || 0),
        };
      });

      return NextResponse.json({
        success: true,
        ...summary,
        matrixAccountsDeactivated,
        matrixAccountsUnconfigured,
        warning: "PostgreSQL и чаты приложения очищены. История E2EE-комнат хранится в Synapse и этой операцией не удаляется.",
      });
    } catch {
      return NextResponse.json({ error: "Nuclear wipe не завершён; проверьте соединение с PostgreSQL и журнал аудита" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
}
