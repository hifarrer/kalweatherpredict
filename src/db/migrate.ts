import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Run pending Drizzle migrations programmatically.
 *
 * Used by the instrumentation hook so migrations are applied automatically on
 * every server start (including Railway deploys) without a manual command.
 */
export async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
}
