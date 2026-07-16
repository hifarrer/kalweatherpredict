import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { events, predictionSnapshots, settlements, suggestions } from "@/db/schema";
import { getEvent } from "@/lib/kalshi";
import { computeSuggestedActions } from "@/lib/suggest";
import { utcToLocalDateString } from "@/lib/predictor";
import { getOpenCryptoEventsFromDb } from "@/lib/crypto/cryptoSync";
import { buildEnrichedCryptoEvents } from "@/lib/crypto/cryptoEnrich";

/**
 * Crypto accuracy tracking — snapshots and settlements, mirroring
 * history.ts. Grading is intentionally absent: the generic
 * gradeSuggestions() joins on market_ticker and covers crypto rows.
 */

/** Markets closing within this window get an is_final snapshot. */
const FINAL_SNAPSHOT_WINDOW_MS = 70 * 60 * 1000;
/** Per-market 24h volume floor for snapshot rows (hourly ladders have ~60
 * strikes each, most with zero volume — snapshotting them all would bloat
 * the table without adding gradable signal). */
const SNAPSHOT_MIN_VOLUME_24H = 1;
const SUGGESTIONS_PER_EVENT = 10;
/** Crypto markets settle instantly at close — a short lookback drains fast. */
const SETTLEMENT_LOOKBACK_DAYS = 3;
const SETTLEMENTS_PER_RUN = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Record current crypto predictions as snapshot rows (+ scheduled suggestion
 * rows on the broad pass). Same dedupe semantics as the weather job: the
 * final pass runs every scheduler tick but records one is_final row per
 * market at most.
 */
export async function snapshotCryptoPredictions(opts?: {
  finalOnly?: boolean;
}): Promise<number> {
  const rows = await getOpenCryptoEventsFromDb();
  if (rows.length === 0) return 0;

  const { events: enriched } = await buildEnrichedCryptoEvents(rows);
  const now = Date.now();

  type SnapshotRow = typeof predictionSnapshots.$inferInsert;
  type SuggestionRow = typeof suggestions.$inferInsert;
  const toInsert: SnapshotRow[] = [];
  const suggestionRows: SuggestionRow[] = [];
  const finalCandidates: string[] = [];

  for (const e of enriched) {
    const prediction = e.prediction;
    if (!prediction?.marketLikelihoods || !e.event.markets) continue;
    if (e.volume <= 0 && e.volume24h <= 0) continue;

    if (!opts?.finalOnly) {
      for (const s of computeSuggestedActions(e, SUGGESTIONS_PER_EVENT)) {
        suggestionRows.push({
          eventTicker: e.event.event_ticker,
          marketTicker: s.ticker,
          side: s.side,
          kind: s.kind,
          source: "scheduled",
          price: s.price,
          forecastProb: s.forecastProb,
          blendedProb: s.blendedProb,
          winProb: s.winProb,
          marketProb: s.marketProb,
          feePerContract: s.feePerContract,
          evPerContract: s.evPerContract,
          score: s.score,
          volume24h: s.volume24h,
          cityCode: null,
          section: "crypto",
          asset: e.asset ?? null,
          metric: prediction.metric,
          targetDate: prediction.targetDate ?? null,
          leadDays: null,
          tauHours: prediction.tauHours ?? null,
          decided: s.decided ?? null,
          obsBacked: s.obsBacked ?? null,
          blendW: s.blendWeight ?? null,
        });
      }
    }

    const marketByTicker = new Map(e.event.markets.map((m) => [m.ticker, m]));

    for (const ml of prediction.marketLikelihoods) {
      const market = marketByTicker.get(ml.ticker);
      if (!market) continue;
      if (parseFloat(market.volume_24h_fp || "0") < SNAPSHOT_MIN_VOLUME_24H) continue;

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
        cityCode: null,
        section: "crypto",
        asset: e.asset ?? null,
        metric: prediction.metric,
        leadDays: null,
        tauHours: prediction.tauHours ?? null,
        forecastValue: prediction.forecastValue,
        sigma: prediction.sigma ?? null,
        modelSpread: null,
        predictedProb: ml.probability,
        marketProb: ml.marketProb ?? null,
        isFinal,
      });
    }
  }

  // One final snapshot per market, same as the weather job
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
          toInsert[i].isFinal = false;
        }
      }
    }
  }

  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    await db.insert(predictionSnapshots).values(toInsert.slice(i, i + CHUNK));
  }
  for (let i = 0; i < suggestionRows.length; i += CHUNK) {
    await db.insert(suggestions).values(suggestionRows.slice(i, i + CHUNK));
  }

  if (toInsert.length > 0) {
    console.log(
      `[crypto/history] recorded ${toInsert.length} prediction snapshots${opts?.finalOnly ? " (final)" : ""}`,
    );
  }
  return toInsert.length;
}

/**
 * Parse a settlement expiration_value that may carry formatting
 * ("$64,123.45" → 64123.45).
 */
export function parseSettlementValue(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const v = parseFloat(String(raw).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(v) ? v : null;
}

/** Fetch settlements for recently expired crypto events missing rows. */
export async function fetchCryptoSettlements(): Promise<number> {
  const cutoffIso = new Date(
    Date.now() - SETTLEMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const expired = await db
    .select({
      eventTicker: events.eventTicker,
      asset: events.asset,
    })
    .from(events)
    .where(
      and(
        eq(events.status, "expired"),
        eq(events.section, "crypto"),
        gte(events.earliestClose, cutoffIso),
      ),
    );
  if (expired.length === 0) return 0;

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

      type SettlementRow = typeof settlements.$inferInsert;
      const rows: SettlementRow[] = [];

      for (const m of fresh.markets) {
        if (m.result !== "yes" && m.result !== "no") continue;
        rows.push({
          marketTicker: m.ticker,
          eventTicker: fresh.event_ticker,
          cityCode: null,
          section: "crypto",
          asset: row.asset,
          metric: "crypto_price",
          targetDate: m.close_time
            ? utcToLocalDateString(m.close_time, "America/New_York")
            : null,
          result: m.result,
          actualValue: parseSettlementValue(m.expiration_value),
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
      console.error(`[crypto/history] settlement fetch failed for ${row.eventTicker}:`, err);
    }
    await sleep(200);
  }

  if (inserted > 0) {
    console.log(`[crypto/history] recorded ${inserted} settlements`);
  }
  return inserted;
}
