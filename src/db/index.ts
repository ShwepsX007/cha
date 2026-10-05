import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and set the PostgreSQL connection string.",
  );
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

function createPool(): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Bounded pool: a single Next.js process should never exhaust PostgreSQL's
    // max_connections, especially when several instances run under pm2.
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
  });

  // An idle client error (PostgreSQL restart, network reset, timeout) is
  // emitted on the pool. Without a listener Node treats it as an unhandled
  // 'error' event and kills the whole process, which looks like "the app
  // randomly died" in pm2. Log it and let the pool create a fresh client.
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error.message);
  });

  return pool;
}

export const pool = globalForDb.__arenaNextJsPostgresqlPool ?? createPool();

// Cache the pool on globalThis in every environment: with the App Router each
// route can be evaluated in its own module graph, and reusing one pool keeps
// the number of PostgreSQL connections predictable.
globalForDb.__arenaNextJsPostgresqlPool = pool;

export const db = drizzle(pool);
