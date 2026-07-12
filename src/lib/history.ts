import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events, predictionSnapshots, settlements, suggestions } from "@/db/schema";
import { KalshiEvent } from "@/types";
import { getEvent } from "@/lib/kalshi";
import { getOpenEventsFromDb } from "@/lib/sync";
import { buildEnrichedEvents } from "@/lib/enrich";
import { computeSuggestedActions } from "@/lib/suggest";
import { detectMetric, parseDateFromTitle, utcToLocalDateString } from "@/lib/predictor";
import { CITY_MAP } from "@/lib/cities";

/** Markets closing within this window get an is_final snapshot. */
const FINAL_SNAPSHOT_WINDOW_MS = 70 * 60 * 1000;
/** Snapshots older than this are pruned. */
const SNAPSHOT_RETENTION_DAYS = 90;
/** Ungraded suggestion snapshots older than this are pruned (never settled). */
const UNGRADED_SUGGESTION_RETENTION_DAYS = 30;
/** Suggestions persisted per event on the hourly pass. */
const SUGGESTIONS_PER_EVENT = 10;
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
  type SuggestionRow = typeof suggestions.$inferInsert;
  const toInsert: SnapshotRow[] = [];
  const suggestionRows: SuggestionRow[] = [];
  const finalCandidates: string[] = [];

  for (const e of enriched) {
    const prediction = e.prediction;
    if (!prediction?.marketLikelihoods || !e.event.markets) continue;
    if (e.volume <= 0 && e.volume24h <= 0) continue;

    // On the broad hourly pass, also persist what the suggestion scorer would
    // show right now — the raw material for grading AI-pick accuracy later.
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
          cityCode: e.cityCode,
          section: "weather",
          metric: prediction.metric,
          targetDate: prediction.targetDate ?? null,
          leadDays: prediction.leadDays ?? null,
        });
      }
    }

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
        section: "weather",
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
  for (let i = 0; i < suggestionRows.length; i += CHUNK) {
    await db.insert(suggestions).values(suggestionRows.slice(i, i + CHUNK));
  }

  if (toInsert.length > 0) {
    console.log(
      `[history] recorded ${toInsert.length} prediction snapshots${opts?.finalOnly ? " (final)" : ""}`,
    );
  }
  if (suggestionRows.length > 0) {
    console.log(`[history] recorded ${suggestionRows.length} suggestion snapshots`);
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
        eq(events.section, "weather"),
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
          section: "weather",
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
 * Grade ungraded suggestion snapshots against settled markets: did the
 * suggested side win, and what was the realized EV per contract at the
 * snapshot's ask. Set-based and idempotent — a cheap no-op when nothing new
 * has settled, so it runs every scheduler tick after fetchSettlements().
 */
export async function gradeSuggestions(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE suggestions s
    SET result = st.result,
        suggested_side_won = (s.side = st.result),
        realized_ev = (CASE WHEN s.side = st.result THEN 1.0 ELSE 0.0 END)
          - s.price - s.fee_per_contract,
        graded_at = now()
    FROM settlements st
    WHERE st.market_ticker = s.market_ticker AND s.graded_at IS NULL
  `);
  const graded = result.rowCount ?? 0;
  if (graded > 0) {
    console.log(`[history] graded ${graded} suggestion snapshots`);
  }
  return graded;
}

/**
 * Delete snapshots past the retention window. Graded suggestion snapshots are
 * kept forever — they're the training dataset — but ungraded ones whose
 * markets never got a settlement are useless and get dropped after 30 days.
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

  const suggestionCutoff = new Date(
    Date.now() - UNGRADED_SUGGESTION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  // Only scheduled rows: "order" rows are referenced by orders.suggestion_id
  // and stay as the record of what the user acted on, graded or not.
  const prunedSuggestions = await db
    .delete(suggestions)
    .where(
      and(
        isNull(suggestions.gradedAt),
        eq(suggestions.source, "scheduled"),
        lt(suggestions.createdAt, suggestionCutoff),
      ),
    )
    .returning({ id: suggestions.id });
  if (prunedSuggestions.length > 0) {
    console.log(
      `[history] pruned ${prunedSuggestions.length} ungraded suggestion snapshots`,
    );
  }

  return result.length;
}
