import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getMatrixHealthStatus } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

const REQUIRED_TABLES = [
  "users",
  "chats",
  "chat_members",
  "messages",
  "message_receipts",
  "push_subscriptions",
  "admin_audit_logs",
];

/**
 * Safe, secret-free readiness probe:
 *   curl -s https://<host>/api/health
 *
 * It reports the database connection, whether the schema was provisioned, and
 * which optional integrations are configured. `ok: false` with
 * `schema: "missing"` is the signature of a server that was started before
 * `npm run db:setup` — the exact situation where `next start` logs "Ready" but
 * every page fails.
 */
export async function GET() {
  const config = {
    jwtSecret: Boolean(process.env.JWT_SECRET),
    matrix: Boolean(
      process.env.MATRIX_INTERNAL_URL &&
        process.env.MATRIX_PUBLIC_URL &&
        process.env.MATRIX_SERVER_NAME &&
        process.env.MATRIX_ADMIN_ACCESS_TOKEN,
    ),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    push: Boolean(
      process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_EMAIL,
    ),
  };

  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    console.error("Health check: database unavailable:", error);
    return Response.json(
      { ok: false, database: "unavailable", schema: "unknown", config },
      { status: 500 },
    );
  }

  let schema: "ok" | "missing" = "ok";
  let missingTables: string[] = [];
  try {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const existing = new Set(result.rows.map((row) => row.table_name));
    missingTables = REQUIRED_TABLES.filter((table) => !existing.has(table));
    if (missingTables.length > 0) schema = "missing";
  } catch (error) {
    console.error("Health check: schema probe failed:", error);
    schema = "missing";
  }

  const matrix = await getMatrixHealthStatus();
  const ok = schema === "ok" && config.jwtSecret;

  return Response.json(
    {
      ok,
      database: "ok",
      schema,
      ...(missingTables.length > 0 ? { missingTables, hint: "Run: npm run db:setup" } : {}),
      matrix,
      config,
    },
    { status: ok ? 200 : 503 },
  );
}
