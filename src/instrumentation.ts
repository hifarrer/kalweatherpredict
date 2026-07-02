/**
 * Next.js instrumentation hook — runs once on server startup.
 *
 * On production deploys (including Railway) this auto-applies migrations and
 * starts the background sync scheduler without needing a custom start command.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrations } = await import("./db/migrate");
    await runMigrations().catch((e) =>
      console.error("DB migration failed:", e),
    );

    const { startSyncScheduler } = await import("./lib/sync");
    startSyncScheduler();
  }
}
