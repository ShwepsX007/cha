import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, users } from "@/db/schema";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
    const logs = await db
      .select({
        id: adminAuditLogs.id,
        adminId: adminAuditLogs.adminId,
        adminUsername: users.username,
        action: adminAuditLogs.action,
        targetType: adminAuditLogs.targetType,
        targetId: adminAuditLogs.targetId,
        details: adminAuditLogs.details,
        createdAt: adminAuditLogs.createdAt,
      })
      .from(adminAuditLogs)
      .leftJoin(users, eq(adminAuditLogs.adminId, users.id))
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limit);

    return NextResponse.json({ logs }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Не удалось загрузить журнал аудита" }, { status: 500 });
  }
}
