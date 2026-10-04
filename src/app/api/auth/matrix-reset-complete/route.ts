import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { matrixDeviceExistsForAppUser } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentUser();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json();
    const deviceId = body && typeof body === "object"
      ? (body as { deviceId?: unknown }).deviceId
      : null;
    if (typeof deviceId !== "string" || !/^[A-Za-z0-9._=-]{1,255}$/u.test(deviceId)) {
      return NextResponse.json({ error: "Некорректный Matrix device ID" }, { status: 400 });
    }

    const [user] = await db
      .select({ matrixResetRequired: users.matrixResetRequired })
      .from(users)
      .where(eq(users.id, session.userId));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!user.matrixResetRequired) return NextResponse.json({ reset: true });

    if (!(await matrixDeviceExistsForAppUser(session.userId, deviceId))) {
      return NextResponse.json({ error: "Новая Matrix-сессия ещё не подтверждена сервером" }, { status: 409 });
    }

    await db.update(users)
      .set({ matrixResetRequired: false })
      .where(eq(users.id, session.userId));

    return NextResponse.json({ reset: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Matrix reset completion failed");
    return NextResponse.json({ error: "Не удалось подтвердить завершение Matrix-сброса" }, { status: 503 });
  }
}
