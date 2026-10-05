import { db } from "@/db";
import { sql } from "drizzle-orm";
import { isPushConfigured, missingPushEnv } from "@/lib/push";

export const dynamic = "force-dynamic";

const REQUIRED_TABLES = [
  "users",
  "chats",
  "chat_members",
  "messages",
  "message_receipts",
  "push_subscriptions",
  "admin_audit_logs",
  "captcha_nonces",
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
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    // Same predicate the sending code uses, so the probe cannot lie about push.
    push: isPushConfigured(),
  };
  const pushMissing = missingPushEnv();

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

  const ok = schema === "ok" && config.jwtSecret;

  return Response.json(
    {
      ok,
      database: "ok",
      schema,
      ...(missingTables.length > 0 ? { missingTables, hint: "Run: npm run db:setup" } : {}),
      ...(pushMissing.length > 0 ? { pushMissingEnv: pushMissing } : {}),
      config,
    },
    { status: ok ? 200 : 503 },
  );
}
