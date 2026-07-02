import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Singleton pg Pool + Drizzle instance.
 *
 * In development, Next.js reloads modules on hot-reload which would otherwise
 * create a new Pool each time, exhausting DB connections. We stash the pool on
 * globalThis to reuse it across reloads.
 */
const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool =
  globalForDb.pool ??
  new Pool({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
}

export const db = drizzle(pool, { schema });
