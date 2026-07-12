import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { events, syncMeta } from "@/db/schema";
import { KalshiEvent } from "@/types";
import { computeEarliestClose, getEventsBySeries } from "@/lib/kalshi";
import { CRYPTO_ASSETS } from "@/lib/crypto/assets";
import { expireStaleEvents } from "@/lib/sync";

/**
 * DB sync for crypto events — the crypto counterpart of sync.ts. Rows live
 * in the shared events table under section = "crypto" with the asset code.
 *
 * Unlike weather (which keyword-scans every Kalshi series), crypto knows its
 * series tickers up front, so a full sync is a handful of per-series pages.
 * Hourly ladders come and go quickly, so the sync interval is 5 minutes.
 */

const CRYPTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LAST_SYNC_KEY = "last_crypto_sync_at";
const CALIBRATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CALIBRATION_KEY = "last_crypto_calibration_at";

let activeSync: Promise<number> | null = null;

async function doCryptoFullSync(): Promise<number> {
  console.log("[crypto/sync] starting full sync...");
  const nowTs = Math.floor(Date.now() / 1000);
  let upserted = 0;

  for (const asset of CRYPTO_ASSETS) {
    for (const seriesTicker of asset.kalshiSeriesTickers) {
      let apiEvents: KalshiEvent[];
      try {
        apiEvents = await getEventsBySeries(seriesTicker, "open", { minCloseTs: nowTs });
      } catch (err) {
        console.error(`[crypto/sync] fetch failed for ${seriesTicker}:`, err);
        continue;
      }

      for (const e of apiEvents) {
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
            cityCode: null,
            section: "crypto",
            asset: asset.code,
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
              section: "crypto",
              asset: asset.code,
              status: "open",
              data: e as unknown as Record<string, unknown>,
              earliestClose,
              lastUpdatedAt: new Date(),
            },
          });
        upserted++;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const expiredCount = await expireStaleEvents(); // generic: covers both sections

  await db
    .insert(syncMeta)
    .values({ key: LAST_SYNC_KEY, value: { ts: Date.now() } })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: { ts: Date.now() }, updatedAt: new Date() },
    });

  console.log(`[crypto/sync] done — upserted ${upserted}, expired ${expiredCount}`);
  return upserted;
}

/** Same promise-dedup semantics as runFullSync() in sync.ts. */
export async function runCryptoFullSync(): Promise<number> {
  if (activeSync) await activeSync;
  if (activeSync) return activeSync;

  const promise = doCryptoFullSync();
  activeSync = promise;
  try {
    return await promise;
  } catch (err) {
    console.error("[crypto/sync] full sync failed:", err);
    return 0;
  } finally {
    if (activeSync === promise) activeSync = null;
  }
}

export async function syncCryptoEventsIfNeeded(opts?: {
  force?: boolean;
}): Promise<{ synced: boolean }> {
  await expireStaleEvents();

  const row = await db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, LAST_SYNC_KEY))
    .limit(1);
  const lastSyncTs = row.length > 0 ? ((row[0].value as { ts: number }).ts ?? 0) : 0;

  if (opts?.force || Date.now() - lastSyncTs > CRYPTO_SYNC_INTERVAL_MS) {
    await runCryptoFullSync();
    return { synced: true };
  }
  return { synced: false };
}

export interface CryptoDbEventRow {
  event: KalshiEvent;
  asset: string | null;
  earliestClose: string | null;
}

export async function getOpenCryptoEventsFromDb(): Promise<CryptoDbEventRow[]> {
  const rows = await db
    .select({
      data: events.data,
      asset: events.asset,
      earliestClose: events.earliestClose,
    })
    .from(events)
    .where(and(eq(events.status, "open"), eq(events.section, "crypto")));

  return rows.map((r) => ({
    event: r.data as unknown as KalshiEvent,
    asset: r.asset,
    earliestClose: r.earliestClose,
  }));
}

async function getMetaTs(key: string): Promise<number> {
  const row = await db.select().from(syncMeta).where(eq(syncMeta.key, key)).limit(1);
  if (row.length === 0) return 0;
  return (row[0].value as { ts?: number })?.ts ?? 0;
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
 * All recurring crypto jobs, called from the shared scheduler after the
 * weather chain (with its own catch so crypto failures never break weather):
 * sync → snapshots (broad hourly + finals every tick) → settlements →
 * daily vol calibration. Suggestion grading is NOT here — the generic
 * gradeSuggestions() in the weather chain already grades crypto rows.
 */
export async function runCryptoJobs(): Promise<void> {
  const { snapshotCryptoPredictions, fetchCryptoSettlements } = await import(
    "@/lib/crypto/cryptoHistory"
  );

  await syncCryptoEventsIfNeeded();

  const now = Date.now();
  const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
  if (now - (await getMetaTs("last_crypto_snapshot_at")) > SNAPSHOT_INTERVAL_MS) {
    await snapshotCryptoPredictions();
    await setMetaTs("last_crypto_snapshot_at");
  } else {
    await snapshotCryptoPredictions({ finalOnly: true });
  }

  await fetchCryptoSettlements();

  if (now - (await getMetaTs(CALIBRATION_KEY)) > CALIBRATION_INTERVAL_MS) {
    const { recomputeCryptoVolCalibration } = await import(
      "@/lib/crypto/cryptoVolCalibration"
    );
    await recomputeCryptoVolCalibration();
    await setMetaTs(CALIBRATION_KEY);
  }
}
