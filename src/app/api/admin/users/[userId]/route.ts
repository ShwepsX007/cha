import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { deactivateMatrixIdentityForAppUser, resetMatrixDevicesForAppUser } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

const BAN_DURATIONS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "100y": 100 * 365 * 24 * 60 * 60 * 1000,
};

async function findUser(userId: number) {
  const [user] = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  return user;
}

async function adminCount() {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "admin"));
  return Number(row?.count || 0);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const userId = Number((await params).userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Некорректный ID пользователя" }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const input = body as { action?: unknown; duration?: unknown; reason?: unknown; role?: unknown };
  const target = await findUser(userId);
  if (!target) return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });

  try {
    if (input.action === "ban") {
      if (userId === auth.admin.id) {
        return NextResponse.json({ error: "Нельзя заблокировать собственный аккаунт" }, { status: 400 });
      }
      if (typeof input.duration !== "string" || !Object.prototype.hasOwnProperty.call(BAN_DURATIONS, input.duration)) {
        return NextResponse.json({ error: "Выберите допустимый срок блокировки" }, { status: 400 });
      }
      const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
      const bannedUntil = new Date(Date.now() + BAN_DURATIONS[input.duration]);
      await db.update(users).set({ bannedUntil, banReason: reason || null }).where(eq(users.id, userId));
      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "user.ban",
        targetType: "user",
        targetId: String(userId),
        details: { username: target.username, duration: input.duration, bannedUntil: bannedUntil.toISOString(), reason: reason || null },
      });
      return NextResponse.json({ success: true, bannedUntil, banReason: reason || null });
    }

    if (input.action === "unban") {
      await db.update(users).set({ bannedUntil: null, banReason: null }).where(eq(users.id, userId));
      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "user.unban",
        targetType: "user",
        targetId: String(userId),
        details: { username: target.username },
      });
      return NextResponse.json({ success: true });
    }

    if (input.action === "role") {
      if (input.role !== "user" && input.role !== "admin") {
        return NextResponse.json({ error: "Некорректная роль" }, { status: 400 });
      }
      if (target.role === "admin" && input.role === "user" && await adminCount() <= 1) {
        return NextResponse.json({ error: "Нельзя снять роль с последнего администратора" }, { status: 409 });
      }
      await db.update(users).set({ role: input.role }).where(eq(users.id, userId));
      await writeAdminAuditLog({
        adminId: auth.admin.id,
        action: "user.role_change",
        targetType: "user",
        targetId: String(userId),
        details: { username: target.username, from: target.role, to: input.role },
      });
      return NextResponse.json({ success: true, role: input.role });
    }

    if (input.action === "matrix_reset") {
      await db.update(users).set({ matrixResetRequired: true }).where(eq(users.id, userId));
      try {
        const matrix = await resetMatrixDevicesForAppUser(userId);
        await writeAdminAuditLog({
          adminId: auth.admin.id,
          action: "user.matrix_reset",
          targetType: "user",
          targetId: String(userId),
          details: { username: target.username, matrixConfigured: matrix.configured, revokedDevices: matrix.revokedDevices },
        });
        return NextResponse.json({
          success: true,
          resetRequired: true,
          matrixDevicesRevoked: matrix.revokedDevices,
          warning: matrix.configured ? null : "Matrix не настроен; флаг сброса установлен, устройства Synapse не отозваны.",
        }, { status: matrix.configured ? 200 : 202 });
      } catch {
        await writeAdminAuditLog({
          adminId: auth.admin.id,
          action: "user.matrix_reset_failed",
          targetType: "user",
          targetId: String(userId),
          details: { username: target.username, resetFlagKept: true },
        });
        return NextResponse.json({
          success: false,
          resetRequired: true,
          error: "Флаг Matrix-сброса установлен, но Synapse не подтвердил отзыв старых устройств.",
        }, { status: 202 });
      }
    }

    return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Не удалось выполнить действие администратора" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  const userId = Number((await params).userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Некорректный ID пользователя" }, { status: 400 });
  }
  if (userId === auth.admin.id) {
    return NextResponse.json({ error: "Нельзя удалить собственный аккаунт" }, { status: 400 });
  }

  const target = await findUser(userId);
  if (!target) return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
  if (target.role === "admin" && await adminCount() <= 1) {
    return NextResponse.json({ error: "Нельзя удалить последнего администратора" }, { status: 409 });
  }

  try {
    const matrix = await deactivateMatrixIdentityForAppUser(userId);
    await db.delete(users).where(eq(users.id, userId));
    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "user.delete",
      targetType: "user",
      targetId: String(userId),
      details: { username: target.username, displayName: target.displayName, matrixConfigured: matrix.configured },
    });
    return NextResponse.json({ success: true, matrixAccountDeactivated: matrix.configured });
  } catch {
    return NextResponse.json({ error: "Не удалось удалить пользователя. Если Synapse недоступен, запись PostgreSQL сохранена." }, { status: 502 });
  }
}
