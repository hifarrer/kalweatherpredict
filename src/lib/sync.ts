import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { events, syncMeta } from "@/db/schema";
import { KalshiEvent } from "@/types";
import {
  getWeatherEvents,
  getWeatherSeriesTickers,
  computeEarliestClose,
} from "@/lib/kalshi";
import { detectCity } from "@/lib/cities";

// --- Tuning constants ---

const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000; // discover + upsert every 15 min
const SERIES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // weather series list cached 6h
const SCHEDULER_INTERVAL_MS = 10 * 60 * 1000; // background timer fires every 10 min

// In-process lock so overlapping syncs are skipped (e.g. timer + request)
let isSyncing = false;

/**
 * Return the set of weather series tickers, backed by the DB (sync_meta).
 *
 * If the stored list is fresh (within SERIES_CACHE_TTL_MS) we reuse it;
 * otherwise we page the Kalshi API and persist the result so server restarts
 * don't trigger a full re-page.
 */
export async function getWeatherSeriesTickersFromDb(): Promise<Set<string>> {
  const row = await db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, "weather_series"))
    .limit(1);

  const now = Date.now();

  if (row.length > 0) {
    const stored = row[0];
    const age = now - stored.updatedAt.getTime();
    if (age < SERIES_CACHE_TTL_MS) {
      const tickers: string[] = stored.value as string[];
      return new Set(tickers);
    }
  }

  // Stale or missing — re-page the API
  const tickers = await getWeatherSeriesTickers();

  await db
    .insert(syncMeta)
    .values({ key: "weather_series", value: [...tickers] })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: [...tickers], updatedAt: new Date() },
    });

  return tickers;
}

/**
 * Expire events whose markets have all closed.
 *
 * Called on every read path (cheap) so the dashboard stays correct between
 * full syncs. An event is expired when its earliestClose is in the past.
 */
export async function expireStaleEvents(): Promise<number> {
  const nowIso = new Date().toISOString();

  const result = await db
    .update(events)
    .set({ status: "expired" })
    .where(
      and(
        eq(events.status, "open"),
        isNotNull(events.earliestClose),
        lt(events.earliestClose, nowIso),
      ),
    )
    .returning({ ticker: events.eventTicker });

  return result.length;
}

/**
 * Run a full sync: page Kalshi for all open weather events and upsert them.
 *
 * Guarded by an in-process lock so concurrent callers skip if a sync is
 * already running.
 *
 * Returns the number of events upserted (or 0 if skipped).
 */
export async function runFullSync(): Promise<number> {
  if (isSyncing) {
    console.log("[sync] already running — skipping");
    return 0;
  }
  isSyncing = true;

  try {
    console.log("[sync] starting full sync...");
    const apiEvents = await getWeatherEvents();
    console.log(`[sync] discovered ${apiEvents.length} weather events from Kalshi`);

    let upserted = 0;

    for (const e of apiEvents) {
      const primaryRules = e.markets?.[0]?.rules_primary;
      const city = detectCity(e.title, e.series_ticker, primaryRules);
      const cityCode = city?.code ?? null;
      const earliestClose = computeEarliestClose(e.markets) || null;

      await db
        .insert(events)
        .values({
          eventTicker: e.event_ticker,
          seriesTicker: e.series_ticker,
          title: e.title,
          subTitle: e.sub_title || null,
          category: e.category || null,
          strikeDate: e.strike_date || null,
          cityCode,
          status: "open",
          data: e as unknown as Record<string, unknown>,
          earliestClose,
        })
        .onConflictDoUpdate({
          target: events.eventTicker,
          set: {
            seriesTicker: e.series_ticker,
            title: e.title,
            subTitle: e.sub_title || null,
            category: e.category || null,
            strikeDate: e.strike_date || null,
            cityCode,
            status: "open",
            data: e as unknown as Record<string, unknown>,
            earliestClose,
            lastUpdatedAt: new Date(),
          },
        });

      upserted++;
    }

    // Expire any events that have closed since the last sync
    const expiredCount = await expireStaleEvents();

    // Record the sync time
    await db
      .insert(syncMeta)
      .values({ key: "last_full_sync_at", value: { ts: Date.now() } })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { value: { ts: Date.now() }, updatedAt: new Date() },
      });

    console.log(
      `[sync] done — upserted ${upserted}, expired ${expiredCount}`,
    );
    return upserted;
  } catch (err) {
    console.error("[sync] full sync failed:", err);
    return 0;
  } finally {
    isSyncing = false;
  }
}

/**
 * Sync events if the last sync is stale (or forced).
 *
 * - Always expires stale events first (cheap correctness check).
 * - Runs a full sync when forced, when no sync has happened yet, or when the
 *   last sync is older than FULL_SYNC_INTERVAL_MS.
 *
 * Returns whether a sync was actually performed.
 */
export async function syncEventsIfNeeded(opts?: {
  force?: boolean;
}): Promise<{ synced: boolean }> {
  await expireStaleEvents();

  const row = await db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, "last_full_sync_at"))
    .limit(1);

  const now = Date.now();
  const lastSyncTs =
    row.length > 0
      ? (row[0].value as { ts: number }).ts
      : 0;

  const isStale = now - lastSyncTs > FULL_SYNC_INTERVAL_MS;

  if (opts?.force || lastSyncTs === 0 || isStale) {
    await runFullSync();
    return { synced: true };
  }

  return { synced: false };
}

/**
 * Start the background sync scheduler.
 *
 * Registers a setInterval that triggers a full sync every SCHEDULER_INTERVAL_MS.
 * Also kicks off an initial sync if the DB is empty (cold start after deploy).
 *
 * Guarded by a globalThis flag so the interval is registered only once even
 * if the module is reloaded during development.
 */
export function startSyncScheduler() {
  const g = globalThis as unknown as { __syncSchedulerStarted?: boolean };
  if (g.__syncSchedulerStarted) return;
  g.__syncSchedulerStarted = true;

  console.log("[sync] starting background scheduler");

  // Kick off an initial sync (non-blocking) if needed
  (async () => {
    try {
      const openCount = await db
        .select()
        .from(events)
        .where(eq(events.status, "open"))
        .limit(1);

      if (openCount.length === 0) {
        console.log("[sync] DB empty — running initial sync");
        await runFullSync();
      }
    } catch (err) {
      console.error("[sync] initial sync check failed:", err);
    }
  })();

  setInterval(() => {
    runFullSync().catch((err) =>
      console.error("[sync] scheduled sync error:", err),
    );
  }, SCHEDULER_INTERVAL_MS);
}

/**
 * A DB row mapped to the data the dashboard needs.
 */
export interface DbEventRow {
  event: KalshiEvent;
  cityCode: string | null;
  earliestClose: string | null;
}

/**
 * Fetch all open events from the DB, reconstructing KalshiEvent objects
 * alongside the precomputed cityCode and earliestClose columns.
 */
export async function getOpenEventsFromDb(): Promise<DbEventRow[]> {
  const rows = await db
    .select({
      data: events.data,
      cityCode: events.cityCode,
      earliestClose: events.earliestClose,
    })
    .from(events)
    .where(eq(events.status, "open"));

  return rows.map((r) => ({
    event: r.data as unknown as KalshiEvent,
    cityCode: r.cityCode,
    earliestClose: r.earliestClose,
  }));
}
