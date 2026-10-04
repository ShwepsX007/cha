import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getMatrixHealthStatus } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const matrix = await getMatrixHealthStatus();
    return Response.json({ ok: true, database: "ok", matrix });
  } catch {
    return Response.json({ ok: false, database: "unavailable" }, { status: 500 });
  }
}
