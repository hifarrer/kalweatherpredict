import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { events, predictionSnapshots, settlements } from "@/db/schema";
import { KalshiEvent } from "@/types";
import { getEvent } from "@/lib/kalshi";
import { getOpenEventsFromDb } from "@/lib/sync";
import { buildEnrichedEvents } from "@/lib/enrich";
import { detectMetric, parseDateFromTitle, utcToLocalDateString } from "@/lib/predictor";
import { CITY_MAP } from "@/lib/cities";

/** Markets closing within this window get an is_final snapshot. */
const FINAL_SNAPSHOT_WINDOW_MS = 70 * 60 * 1000;
/** Snapshots older than this are pruned. */
const SNAPSHOT_RETENTION_DAYS = 90;
/** How far back to look for expired events that still need settlements. */
const SETTLEMENT_LOOKBACK_DAYS = 7;
/** Kalshi API fetches per settlement pass (self-limiting). */
const SETTLEMENTS_PER_RUN = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Record the current prediction for every liquid market as snapshot rows.
 *
 * With `finalOnly`, only markets closing within the final-snapshot window
 * are recorded (and only once — markets that already have a final snapshot
 * are skipped). Run hourly for the broad pass and every scheduler tick for
 * the final pass.
 */
export async function snapshotPredictions(opts?: { finalOnly?: boolean }): Promise<number> {
  const rows = await getOpenEventsFromDb();
  if (rows.length === 0) return 0;

  const enriched = await buildEnrichedEvents(rows);
  const now = Date.now();

  type SnapshotRow = typeof predictionSnapshots.$inferInsert;
  const toInsert: SnapshotRow[] = [];
  const finalCandidates: string[] = [];

  for (const e of enriched) {
    const prediction = e.prediction;
    if (!prediction?.marketLikelihoods || !e.event.markets) continue;
    if (e.volume <= 0 && e.volume24h <= 0) continue;

    const marketByTicker = new Map(e.event.markets.map((m) => [m.ticker, m]));

    for (const ml of prediction.marketLikelihoods) {
      const market = marketByTicker.get(ml.ticker);
      if (!market) continue;

      const closeMs = market.close_time ? new Date(market.close_time).getTime() : NaN;
      const isFinal =
        Number.isFinite(closeMs) &&
        closeMs - now > 0 &&
        closeMs - now <= FINAL_SNAPSHOT_WINDOW_MS;

      if (opts?.finalOnly && !isFinal) continue;
      if (isFinal) finalCandidates.push(ml.ticker);

      toInsert.push({
        eventTicker: e.event.event_ticker,
        marketTicker: ml.ticker,
        targetDate: prediction.targetDate ?? null,
        cityCode: ml.cityCode ?? e.cityCode,
        metric: prediction.metric,
        leadDays: prediction.leadDays ?? null,
        forecastValue: ml.forecastValue ?? prediction.forecastValue,
        sigma: prediction.sigma ?? null,
        modelSpread: prediction.modelSpread ?? null,
        predictedProb: ml.probability,
        marketProb: ml.marketProb ?? null,
        isFinal,
      });
    }
  }

  // Don't re-record final snapshots for markets that already have one —
  // the final pass runs every scheduler tick.
  if (finalCandidates.length > 0) {
    const existing = await db
      .selectDistinct({ marketTicker: predictionSnapshots.marketTicker })
      .from(predictionSnapshots)
      .where(
        and(
          eq(predictionSnapshots.isFinal, true),
          inArray(predictionSnapshots.marketTicker, finalCandidates),
        ),
      );
    const alreadyFinal = new Set(existing.map((r) => r.marketTicker));
    for (let i = toInsert.length - 1; i >= 0; i--) {
      if (toInsert[i].isFinal && alreadyFinal.has(toInsert[i].marketTicker)) {
        if (opts?.finalOnly) {
          toInsert.splice(i, 1);
        } else {
          toInsert[i].isFinal = false; // keep as a regular hourly snapshot
        }
      }
    }
  }

  // Chunked insert
  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    await db.insert(predictionSnapshots).values(toInsert.slice(i, i + CHUNK));
  }

  if (toInsert.length > 0) {
    console.log(
      `[history] recorded ${toInsert.length} prediction snapshots${opts?.finalOnly ? " (final)" : ""}`,
    );
  }
  return toInsert.length;
}

/**
 * Fetch settlement results for recently expired events that don't have
 * settlement rows yet. Limited to a few Kalshi API calls per run — the
 * scheduler calls this every tick so the backlog drains quickly.
 */
export async function fetchSettlements(): Promise<number> {
  const cutoffIso = new Date(
    Date.now() - SETTLEMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const expired = await db
    .select({
      eventTicker: events.eventTicker,
      cityCode: events.cityCode,
      data: events.data,
    })
    .from(events)
    .where(
      and(
        eq(events.status, "expired"),
        gte(events.earliestClose, cutoffIso),
      ),
    );

  if (expired.length === 0) return 0;

  // Skip events that already have settlement rows
  const settled = await db
    .selectDistinct({ eventTicker: settlements.eventTicker })
    .from(settlements)
    .where(inArray(settlements.eventTicker, expired.map((e) => e.eventTicker)));
  const settledSet = new Set(settled.map((r) => r.eventTicker));

  const pending = expired.filter((e) => !settledSet.has(e.eventTicker));
  if (pending.length === 0) return 0;

  let inserted = 0;

  for (const row of pending.slice(0, SETTLEMENTS_PER_RUN)) {
    try {
      const fresh = await getEvent(row.eventTicker);
      if (!fresh?.markets) continue;

      const cached = row.data as unknown as KalshiEvent;
      const metric = detectMetric(cached);
      const timezone = row.cityCode ? CITY_MAP[row.cityCode]?.timezone : undefined;
      const titleDate = parseDateFromTitle(cached.title);

      type SettlementRow = typeof settlements.$inferInsert;
      const rows: SettlementRow[] = [];

      for (const m of fresh.markets) {
        if (m.result !== "yes" && m.result !== "no") continue; // not settled yet

        const actual = parseFloat(m.expiration_value);
        rows.push({
          marketTicker: m.ticker,
          eventTicker: fresh.event_ticker,
          cityCode: row.cityCode,
          metric,
          targetDate:
            titleDate ??
            (m.close_time ? utcToLocalDateString(m.close_time, timezone) : null),
          result: m.result,
          actualValue: Number.isFinite(actual) ? actual : null,
          strikeType: m.strike_type || null,
          floorStrike: m.floor_strike,
          capStrike: m.cap_strike,
          settledAt: m.latest_expiration_time ? new Date(m.latest_expiration_time) : null,
        });
      }

      if (rows.length > 0) {
        await db.insert(settlements).values(rows).onConflictDoNothing();
        inserted += rows.length;
      }
    } catch (err) {
      console.error(`[history] settlement fetch failed for ${row.eventTicker}:`, err);
    }
    await sleep(200);
  }

  if (inserted > 0) {
    console.log(`[history] recorded ${inserted} settlements`);
  }
  return inserted;
}

/**
 * Delete snapshots past the retention window.
 */
export async function pruneOldSnapshots(): Promise<number> {
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(predictionSnapshots)
    .where(lt(predictionSnapshots.capturedAt, cutoff))
    .returning({ id: predictionSnapshots.id });
  if (result.length > 0) {
    console.log(`[history] pruned ${result.length} old snapshots`);
  }
  return result.length;
}
