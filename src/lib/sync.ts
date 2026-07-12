import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { events, syncMeta } from "@/db/schema";
import { KalshiEvent } from "@/types";
import {
  getWeatherEvents,
  getWeatherSeriesTickers,
  computeEarliestClose,
} from "@/lib/kalshi";
import { detectCity, detectStationMismatch } from "@/lib/cities";

// --- Tuning constants ---

const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000; // discover + upsert every 15 min
const SERIES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // weather series list cached 6h
const SCHEDULER_INTERVAL_MS = 10 * 60 * 1000; // background timer fires every 10 min
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // broad prediction snapshot hourly
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // prune old snapshots daily
const CALIBRATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // recompute sigma calibration daily

// Promise-based deduplication: concurrent callers share the in-flight sync
// instead of skipping it. After it completes, force-refresh callers get a
// fresh sync so the user always sees up-to-date market prices.
let activeSync: Promise<number> | null = null;

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
 * Internal: perform the actual Kalshi API pagination + DB upsert.
 *
 * Extracted so runFullSync() can handle concurrency/dedup around it.
 */
async function doFullSync(): Promise<number> {
  console.log("[sync] starting full sync...");
  const apiEvents = await getWeatherEvents();
  console.log(`[sync] discovered ${apiEvents.length} weather events from Kalshi`);

  let upserted = 0;

  for (const e of apiEvents) {
    const primaryRules = e.markets?.[0]?.rules_primary;
    const city = detectCity(e.title, e.series_ticker, primaryRules);
    const cityCode = city?.code ?? null;
    if (city) detectStationMismatch(city, primaryRules);
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
        section: "weather",
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
          section: "weather",
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
}

/**
 * Run a full sync: page Kalshi for all open weather events and upsert them.
 *
 * Uses promise-based deduplication so that:
 * 1. If a sync is already in-flight, new callers AWAIT it (instead of
 *    skipping) so they always get the freshest available data.
 * 2. After the in-flight sync completes, the caller starts a NEW sync to
 *    guarantee it sees the very latest market prices (critical for the
 *    manual "Refresh" button).
 * 3. Multiple concurrent callers are deduplicated — they share the
 *    same promise.
 */
export async function runFullSync(): Promise<number> {
  // Wait for any existing sync to finish so we don't lose its results
  if (activeSync) {
    await activeSync;
  }

  // Another caller may have started a sync while we were awaiting above.
  // If so, piggyback on it instead of starting a duplicate.
  if (activeSync) {
    return activeSync;
  }

  const promise = doFullSync();
  activeSync = promise;

  try {
    return await promise;
  } catch (err) {
    console.error("[sync] full sync failed:", err);
    return 0;
  } finally {
    // Only clear if we're still the active sync (another caller may have
    // already replaced it).
    if (activeSync === promise) {
      activeSync = null;
    }
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

// --- Accuracy-tracking jobs (snapshots, settlements, calibration) ---

async function getMetaTs(key: string): Promise<number> {
  const row = await db.select().from(syncMeta).where(eq(syncMeta.key, key)).limit(1);
  if (row.length === 0) return 0;
  const value = row[0].value as { ts?: number };
  return value?.ts ?? 0;
}

async function setMetaTs(key: string): Promise<void> {
  await db
    .insert(syncMeta)
    .values({ key, value: { ts: Date.now() } })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: { ts: Date.now() }, updatedAt: new Date() },
    });
}

/**
 * Run the accuracy-tracking jobs, each gated on its own sync_meta timestamp:
 * - broad prediction snapshot hourly (+ final snapshots for markets closing
 *   soon on every tick, deduped inside snapshotPredictions),
 * - settlement fetch every tick (cheap and self-limiting),
 * - snapshot pruning and sigma recalibration daily.
 *
 * history/calibration are imported dynamically to keep the module graph
 * acyclic (history.ts imports from this file).
 */
export async function runTrackingJobs(): Promise<void> {
  const { snapshotPredictions, fetchSettlements, gradeSuggestions, pruneOldSnapshots } =
    await import("@/lib/history");
  const now = Date.now();

  if (now - (await getMetaTs("last_snapshot_at")) > SNAPSHOT_INTERVAL_MS) {
    await snapshotPredictions();
    await setMetaTs("last_snapshot_at");
  } else {
    await snapshotPredictions({ finalOnly: true });
  }

  await fetchSettlements();
  await gradeSuggestions();

  if (now - (await getMetaTs("last_prune_at")) > PRUNE_INTERVAL_MS) {
    await pruneOldSnapshots();
    await setMetaTs("last_prune_at");
  }

  if (now - (await getMetaTs("last_calibration_at")) > CALIBRATION_INTERVAL_MS) {
    const { recomputeSigmaCalibration } = await import("@/lib/calibrationStore");
    await recomputeSigmaCalibration();
    await setMetaTs("last_calibration_at");
  }
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
      await runTrackingJobs();
    } catch (err) {
      console.error("[sync] initial sync check failed:", err);
    }
  })();

  setInterval(() => {
    runFullSync()
      .then(() => runTrackingJobs())
      .catch((err) => console.error("[sync] scheduled sync error:", err));
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
 * Fetch all open weather events from the DB, reconstructing KalshiEvent
 * objects alongside the precomputed cityCode and earliestClose columns.
 * Crypto events live in the same table under section = "crypto" and are
 * served by src/lib/crypto/cryptoSync.ts.
 */
export async function getOpenEventsFromDb(): Promise<DbEventRow[]> {
  const rows = await db
    .select({
      data: events.data,
      cityCode: events.cityCode,
      earliestClose: events.earliestClose,
    })
    .from(events)
    .where(and(eq(events.status, "open"), eq(events.section, "weather")));

  return rows.map((r) => ({
    event: r.data as unknown as KalshiEvent,
    cityCode: r.cityCode,
    earliestClose: r.earliestClose,
  }));
}
