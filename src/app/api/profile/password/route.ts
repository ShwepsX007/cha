import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getAuthenticatedUser } from "@/lib/profile";
import { synchronizeMatrixAppUserPassword } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  const payload = await getCurrentUser();
  if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    const confirmPassword = typeof body?.confirmPassword === "string" ? body.confirmPassword : "";

    if (!newPassword || !confirmPassword) {
      return NextResponse.json({ error: "Введите новый пароль и подтвердите его" }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: "Новый пароль должен быть не короче 6 символов" }, { status: 400 });
    }
    if (newPassword !== confirmPassword) {
      return NextResponse.json({ error: "Пароли не совпадают" }, { status: 400 });
    }

    const user = await getAuthenticatedUser(payload.userId);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

    let matrixSynced = false;
    try {
      const matrixResult = await synchronizeMatrixAppUserPassword(user.id, user.displayName, newPassword);
      matrixSynced = matrixResult.configured;
    } catch {
      console.error("Matrix password synchronization failed");
    }

    return NextResponse.json({
      success: true,
      matrixSynced,
      warning: matrixSynced ? undefined : "Matrix не настроен или не смог синхронизировать пароль; приватные чаты могут потребовать сброса Matrix после входа.",
    });
  } catch {
    return NextResponse.json({ error: "Не удалось сменить пароль" }, { status: 500 });
  }
}
