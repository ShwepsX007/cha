/**
 * Applies every SQL file in `drizzle/` to the database from DATABASE_URL.
 *
 * Usage:
 *   npm run db:setup              # apply all migrations (idempotent)
 *   npm run db:setup -- --check   # only verify that the schema is complete
 *
 * Plain Node ESM on purpose: the script must also run on a production server
 * installed with `npm ci --omit=dev`, where tsx/drizzle-kit are unavailable.
 * Every migration in `drizzle/` is written to be idempotent, so no migration
 * journal is required and the command is safe to re-run after each deploy.
 */
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const REQUIRED_TABLES = [
  "users",
  "chats",
  "chat_members",
  "messages",
  "message_receipts",
  "push_subscriptions",
  "admin_audit_logs",
];

const checkOnly = process.argv.includes("--check");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const migrationsDir = join(process.cwd(), "drizzle");

async function tableStatus(client) {
  const result = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const existing = new Set(result.rows.map((row) => row.table_name));
  return REQUIRED_TABLES.map((table) => ({ table, exists: existing.has(table) }));
}

async function main() {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`Cannot connect to PostgreSQL: ${error instanceof Error ? error.message : error}`);
    console.error("Check DATABASE_URL, that PostgreSQL is running and that the database exists.");
    process.exit(1);
  }

  try {
    const before = await tableStatus(client);

    if (!checkOnly) {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const sql = await readFile(join(migrationsDir, file), "utf8");
        try {
          await client.query(sql);
          console.log(`applied  ${file}`);
        } catch (error) {
          console.error(`FAILED   ${file}`);
          console.error(error instanceof Error ? error.message : error);
          process.exit(1);
        }
      }
    }

    const after = await tableStatus(client);
    const missing = after.filter((row) => !row.exists);

    if (missing.length > 0) {
      console.error(`Missing tables: ${missing.map((row) => row.table).join(", ")}`);
      console.error(checkOnly ? "Run: npm run db:setup" : "The schema is still incomplete.");
      process.exit(1);
    }

    if (!checkOnly && before.some((row) => !row.exists)) {
      console.log("Base schema created.");
    }
    console.log(`Schema OK (${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length} tables).`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
