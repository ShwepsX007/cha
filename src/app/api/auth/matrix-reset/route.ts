import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { resetMatrixDevicesForAppUser } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getCurrentUser();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await db.update(users)
      .set({ matrixResetRequired: true })
      .where(eq(users.id, session.userId));
    const matrix = await resetMatrixDevicesForAppUser(session.userId);
    return NextResponse.json({ resetRequired: true, matrixDevicesRevoked: matrix.revokedDevices });
  } catch {
    // Keep the reset flag even if Synapse is temporarily unavailable. The next
    // login will still get a fresh device ID and replace the local crypto store.
    console.error("Self-service Matrix reset failed");
    return NextResponse.json({
      resetRequired: true,
      warning: "Сброс отмечен, но Synapse не подтвердил отзыв старых устройств.",
    }, { status: 202 });
  }
}
