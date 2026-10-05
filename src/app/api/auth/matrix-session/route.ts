import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { createMatrixSession, matrixDeviceExistsForAppUser } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentUser();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    }
    const input = body as { password?: unknown; deviceId?: unknown };
    if (
      typeof input.password !== "string" || input.password.length < 1 || input.password.length > 1024 ||
      typeof input.deviceId !== "string" || !/^[A-Za-z0-9._=-]{1,255}$/u.test(input.deviceId)
    ) {
      return NextResponse.json({ error: "Требуются пароль аккаунта и Matrix device ID" }, { status: 400 });
    }

    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        matrixResetRequired: users.matrixResetRequired,
      })
      .from(users)
      .where(eq(users.id, session.userId));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await bcrypt.compare(input.password, user.passwordHash))) {
      return NextResponse.json({ error: "Неверный пароль аккаунта" }, { status: 401 });
    }

    const deviceExists = await matrixDeviceExistsForAppUser(user.id, input.deviceId);
    if (user.matrixResetRequired && deviceExists) {
      return NextResponse.json({ error: "Этот device ID уже существует. Создайте новый и повторите попытку." }, { status: 409 });
    }
    if (!user.matrixResetRequired && !deviceExists) {
      return NextResponse.json(
        { error: "Matrix-устройство не найдено. Для нового устройства выполните обычный вход." },
        { status: 404 },
      );
    }

    const matrix = await createMatrixSession({
      appUserId: user.id,
      username: user.username,
      displayName: user.displayName,
      password: input.password,
      deviceId: input.deviceId,
    });
    return NextResponse.json(
      { matrixAvailability: matrix.availability, matrixSession: matrix.session },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    console.error("Fresh Matrix session creation failed");
    return NextResponse.json({ error: "Не удалось создать новую Matrix-сессию" }, { status: 503 });
  }
}
