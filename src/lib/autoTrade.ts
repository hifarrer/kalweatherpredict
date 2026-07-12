import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  automationActions,
  automationPositions,
  automationRuns,
  orders,
  predictionSnapshots,
  settlements,
  suggestions,
} from "@/db/schema";
import {
  createOrder,
  getBalance,
  getPositions,
  isTradingConfigured,
  maxOrderContracts,
  sellPosition,
} from "@/lib/kalshiTrade";
import { getEvent } from "@/lib/kalshi";
import { getOpenEventsFromDb } from "@/lib/sync";
import { buildEnrichedEvents } from "@/lib/enrich";
import {
  computeSuggestedActions,
  kalshiFeePerContract,
  SuggestedAction,
} from "@/lib/suggest";
import { reviewSuggestions } from "@/lib/review";
import { isAiConfigured } from "@/lib/analyze";
import { getForecast } from "@/lib/weather";
import { CITY_MAP } from "@/lib/cities";
import {
  AutomationSettings,
  getAutomationSettings,
} from "@/lib/autoSettings";
import { EnrichedEvent, KalshiEvent, KalshiMarket } from "@/types";

/**
 * The automation engine: one runAutoTrade() call per external cron hit (or
 * manual "Run now"). Sells first to free budget, then buys the best
 * AI-approved suggestions. Every decision — including skips — is written to
 * automation_actions so the /automation page can show why the bot acted.
 */

const BUY_BUFFER_CENTS = 5; // same aggressive-IOC buffer as the manual route
const SELL_BUFFER_CENTS = 3; // accept up to 3¢ under the quoted bid
const LEASE_KEY = "auto_trade_lease";
const LEASE_TTL_MS = 5 * 60 * 1000;
const STALE_PENDING_MS = 10 * 60 * 1000;

export interface RunSummary {
  runId: number | null;
  status: "ok" | "error" | "skipped";
  reason?: string;
  candidates: number;
  buys: number;
  sells: number;
  error?: string;
}

// --- Pure decision helpers (unit-tested) -----------------------------------

export type ExitReason = "take_profit" | "stop_loss" | null;

/**
 * Should a position bought at costCents be exited at the current bidCents?
 * Take-profit wins over stop-loss when both would somehow trigger.
 */
export function evaluateExit(
  costCents: number,
  bidCents: number,
  settings: Pick<
    AutomationSettings,
    "takeProfitMode" | "takeProfitValue" | "stopLossEnabled" | "stopLossPct"
  >,
): ExitReason {
  if (costCents <= 0 || bidCents <= 0) return null;
  const gain = bidCents - costCents;
  const tpHit =
    settings.takeProfitMode === "profit_pct"
      ? gain / costCents >= settings.takeProfitValue / 100
      : costCents < 100 &&
        gain / (100 - costCents) >= settings.takeProfitValue / 100;
  if (tpHit) return "take_profit";
  if (
    settings.stopLossEnabled &&
    (costCents - bidCents) / costCents >= settings.stopLossPct / 100
  ) {
    return "stop_loss";
  }
  return null;
}

// Stop-loss suppression: only a strongly confident model may override the
// market, and never once the book prices the held side as near-dead. The old
// >=50% bar let the model ride 12 losers to settlement (−$7.25 in settled
// exits) — when model and market disagreed, the market won almost every time.
const STOP_SUPPRESS_MIN_MODEL_WIN = 0.75;
const MARKET_DEAD_BID_CENTS = 15;
const MARKET_DEAD_DRAWDOWN = 0.5;

/**
 * May the model veto a triggered stop-loss? True only when the latest model
 * win prob is high AND the market hasn't collapsed to near-certainty against
 * the position (bid ≤ 15¢ at ≥50% drawdown ⇒ trust the market and cut).
 */
export function maySuppressStopLoss(
  modelWin: number | null,
  costCents: number,
  bidCents: number,
): boolean {
  if (modelWin === null || modelWin < STOP_SUPPRESS_MIN_MODEL_WIN) return false;
  const marketDead =
    bidCents <= MARKET_DEAD_BID_CENTS &&
    costCents > 0 &&
    (costCents - bidCents) / costCents >= MARKET_DEAD_DRAWDOWN;
  return !marketDead;
}

/**
 * How many contracts to buy at maxPriceCents (+ fee) without exceeding the
 * per-trade cap, the remaining budget, or the global contract cap.
 */
export function sizeContracts(
  maxPriceCents: number,
  feeCents: number,
  maxPerTradeCents: number,
  budgetLeftCents: number,
  contractCap: number,
): number {
  const perContract = maxPriceCents + feeCents;
  if (perContract <= 0) return 0;
  return Math.max(
    0,
    Math.min(
      Math.floor(maxPerTradeCents / perContract),
      Math.floor(budgetLeftCents / perContract),
      contractCap,
    ),
  );
}

// --- Run lease (overlap protection) -----------------------------------------

let runInFlight = false;

/**
 * DB-level compare-and-set lease so overlapping cron hits (or a second
 * server instance) can't run two trading passes at once. Self-expires after
 * LEASE_TTL_MS in case a run dies without releasing.
 */
async function acquireRunLease(): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - LEASE_TTL_MS;
  const value = JSON.stringify({ ts: now });
  const res = await db.execute(sql`
    INSERT INTO sync_meta (key, value)
    VALUES (${LEASE_KEY}, ${value}::jsonb)
    ON CONFLICT (key) DO UPDATE
      SET value = excluded.value, updated_at = now()
      WHERE COALESCE((sync_meta.value->>'ts')::bigint, 0) < ${cutoff}
    RETURNING key
  `);
  return (res.rowCount ?? res.rows.length) > 0;
}

async function releaseRunLease(): Promise<void> {
  const value = JSON.stringify({ ts: 0 });
  await db.execute(sql`
    UPDATE sync_meta SET value = ${value}::jsonb, updated_at = now()
    WHERE key = ${LEASE_KEY}
  `);
}

// --- Logging helpers ---------------------------------------------------------

type ActionEntry = {
  kind: "buy" | "sell" | "close_settled" | "skip" | "error" | "info";
  ticker?: string;
  eventTicker?: string;
  side?: string;
  count?: number;
  priceCents?: number;
  reason: string;
  orderId?: number;
  positionId?: number;
  data?: unknown;
};

async function logAction(runId: number, entry: ActionEntry): Promise<void> {
  try {
    await db.insert(automationActions).values({
      runId,
      kind: entry.kind,
      ticker: entry.ticker ?? null,
      eventTicker: entry.eventTicker ?? null,
      side: entry.side ?? null,
      count: entry.count ?? null,
      priceCents: entry.priceCents ?? null,
      reason: entry.reason,
      orderId: entry.orderId ?? null,
      positionId: entry.positionId ?? null,
      data: (entry.data as Record<string, unknown>) ?? null,
    });
  } catch (err) {
    console.error("[autoTrade] failed to log action:", err);
  }
}

// --- Budget / book helpers ---------------------------------------------------

type OpenPosition = typeof automationPositions.$inferSelect;

async function getOpenPositions(): Promise<OpenPosition[]> {
  return db
    .select()
    .from(automationPositions)
    .where(
      and(
        inArray(automationPositions.status, ["open", "closing"]),
        eq(automationPositions.section, "weather"),
      ),
    );
}

function deployedCents(positions: OpenPosition[]): number {
  return positions.reduce(
    (sum, p) => sum + p.count * (p.avgCostCents + (p.buyFeeCents ?? 0)),
    0,
  );
}

// --- Settlement reconciliation ------------------------------------------------

/**
 * Close positions whose market has settled (fetchSettlements() fills the
 * settlements table every scheduler tick). Also fails out stale pending auto
 * orders — IOC orders can't rest, so pending >10 min means the run died
 * mid-call.
 */
async function reconcileSettled(runId: number, positions: OpenPosition[]): Promise<void> {
  await db
    .update(orders)
    .set({ status: "failed", response: { error: "stale pending auto order" } })
    .where(
      and(
        eq(orders.source, "auto"),
        eq(orders.status, "pending"),
        lt(orders.createdAt, new Date(Date.now() - STALE_PENDING_MS)),
      ),
    );

  if (positions.length === 0) return;
  const tickers = positions.map((p) => p.ticker);
  const settled = await db
    .select()
    .from(settlements)
    .where(inArray(settlements.marketTicker, tickers));
  const byTicker = new Map(settled.map((s) => [s.marketTicker, s]));

  for (const pos of positions) {
    const s = byTicker.get(pos.ticker);
    if (!s) continue;
    const won = s.result === pos.side;
    const payout = won ? 100 * pos.count : 0;
    const chunkPnl =
      payout - pos.count * (pos.avgCostCents + (pos.buyFeeCents ?? 0));
    await db
      .update(automationPositions)
      .set({
        status: "closed",
        count: 0,
        exitReason: "settled",
        realizedPnlCents: (pos.realizedPnlCents ?? 0) + chunkPnl,
        closedAt: new Date(),
      })
      .where(eq(automationPositions.id, pos.id));
    await logAction(runId, {
      kind: "close_settled",
      ticker: pos.ticker,
      eventTicker: pos.eventTicker,
      side: pos.side,
      count: pos.count,
      positionId: pos.id,
      reason: `Market settled ${s.result?.toUpperCase()} — position ${won ? "WON" : "LOST"}, P&L ${formatCents(chunkPnl)}`,
    });
    pos.status = "closed"; // keep the in-memory book consistent for this run
    pos.count = 0;
  }
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "+";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function bidCentsFor(market: KalshiMarket, side: string): number {
  const raw = side === "yes" ? market.yes_bid_dollars : market.no_bid_dollars;
  return Math.round(parseFloat(raw || "0") * 100);
}

// --- Sell pass -----------------------------------------------------------------

const MODEL_GUARD_MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Latest model-predicted P(held side wins) from prediction snapshots (written
 * hourly, plus every 10 min for markets near close). Null when no fresh
 * snapshot exists.
 */
async function latestModelWinProb(
  ticker: string,
  side: string,
): Promise<number | null> {
  const rows = await db
    .select({ predictedProb: predictionSnapshots.predictedProb })
    .from(predictionSnapshots)
    .where(
      and(
        eq(predictionSnapshots.marketTicker, ticker),
        gte(
          predictionSnapshots.capturedAt,
          new Date(Date.now() - MODEL_GUARD_MAX_SNAPSHOT_AGE_MS),
        ),
      ),
    )
    .orderBy(desc(predictionSnapshots.capturedAt))
    .limit(1);
  if (rows.length === 0) return null;
  return side === "yes" ? rows[0].predictedProb : 1 - rows[0].predictedProb;
}

async function sellPass(
  runId: number,
  settings: AutomationSettings,
  positions: OpenPosition[],
  kalshiByTicker: Map<string, number>,
): Promise<number> {
  let sells = 0;
  const eventCache = new Map<string, KalshiEvent | null>();

  for (const pos of positions) {
    if (pos.status !== "open" || pos.count <= 0) continue;
    try {
      let event = eventCache.get(pos.eventTicker);
      if (event === undefined) {
        event = await getEvent(pos.eventTicker).catch(() => null);
        eventCache.set(pos.eventTicker, event);
      }
      const market = event?.markets?.find((m) => m.ticker === pos.ticker);
      if (!market || (market.close_time && new Date(market.close_time) <= new Date())) {
        await logAction(runId, {
          kind: "skip",
          ticker: pos.ticker,
          eventTicker: pos.eventTicker,
          positionId: pos.id,
          reason: "Market closed or unavailable — holding to settlement",
        });
        continue;
      }

      const bid = bidCentsFor(market, pos.side);
      if (bid < 1) {
        await logAction(runId, {
          kind: "skip",
          ticker: pos.ticker,
          eventTicker: pos.eventTicker,
          positionId: pos.id,
          reason: `No bid on the ${pos.side.toUpperCase()} side — cannot exit yet`,
        });
        continue;
      }

      const exit = evaluateExit(pos.avgCostCents, bid, settings);
      if (!exit) continue;

      // Stop-loss guard: thin books can show stale bids on positions the
      // model still strongly believes in, so a very confident model may hold
      // through a drawdown — but only up to a point (maySuppressStopLoss).
      if (exit === "stop_loss") {
        const modelWin = await latestModelWinProb(pos.ticker, pos.side);
        if (maySuppressStopLoss(modelWin, pos.avgCostCents, bid)) {
          await logAction(runId, {
            kind: "skip",
            ticker: pos.ticker,
            eventTicker: pos.eventTicker,
            side: pos.side,
            priceCents: bid,
            positionId: pos.id,
            reason: `Stop-loss suppressed: bid is ${bid}¢ (cost ${pos.avgCostCents}¢) but the model still gives ${pos.side.toUpperCase()} a ${Math.round((modelWin ?? 0) * 100)}% win — thin/stale book, holding`,
          });
          continue;
        }
      }

      // Never sell more than Kalshi says we hold (signed: + YES, − NO)
      const actual = kalshiByTicker.get(pos.ticker) ?? 0;
      const actualHeld = pos.side === "yes" ? actual : -actual;
      if (actualHeld <= 0) {
        await logAction(runId, {
          kind: "error",
          ticker: pos.ticker,
          eventTicker: pos.eventTicker,
          positionId: pos.id,
          reason: `Position drift: local book has ${pos.count} ${pos.side.toUpperCase()} but Kalshi reports ${actual} — not selling; investigate`,
        });
        continue;
      }
      const sellCount = Math.min(pos.count, actualHeld);
      const minProceeds = Math.max(1, bid - SELL_BUFFER_CENTS);
      const clientOrderId = randomUUID();

      await db
        .update(automationPositions)
        .set({ status: "closing" })
        .where(eq(automationPositions.id, pos.id));

      const [orderRow] = await db
        .insert(orders)
        .values({
          clientOrderId,
          ticker: pos.ticker,
          eventTicker: pos.eventTicker,
          side: pos.side,
          action: "sell",
          type: "market",
          count: sellCount,
          maxCostCents: sellCount * minProceeds,
          status: "pending",
          source: "auto",
          section: "weather",
          suggestionId: pos.suggestionId,
        })
        .returning({ id: orders.id });

      const placed = await sellPosition({
        ticker: pos.ticker,
        clientOrderId,
        side: pos.side as "yes" | "no",
        count: sellCount,
        minProceedsCents: minProceeds,
      });

      await db
        .update(orders)
        .set({
          status: placed.status,
          kalshiOrderId: placed.orderId,
          avgFillPriceCents: placed.avgFillPriceCents,
          fillCount: placed.fillCount,
          avgFeeCents: placed.avgFeeCents,
          response: placed.raw as Record<string, unknown>,
        })
        .where(eq(orders.id, orderRow.id));

      if (placed.fillCount === 0) {
        await db
          .update(automationPositions)
          .set({ status: "open" })
          .where(eq(automationPositions.id, pos.id));
        await logAction(runId, {
          kind: "skip",
          ticker: pos.ticker,
          eventTicker: pos.eventTicker,
          positionId: pos.id,
          orderId: orderRow.id,
          reason: `${exit === "take_profit" ? "Take-profit" : "Stop-loss"} triggered at bid ${bid}¢ but IOC sell did not fill (book moved) — will retry next run`,
        });
        continue;
      }

      const proceedsPer = placed.avgFillPriceCents ?? minProceeds;
      const sellFeeTotal = (placed.avgFeeCents ?? 0) * placed.fillCount;
      const chunkPnl =
        placed.fillCount * (proceedsPer - pos.avgCostCents - (pos.buyFeeCents ?? 0)) -
        sellFeeTotal;
      const remaining = pos.count - placed.fillCount;
      const closed = remaining <= 0;

      await db
        .update(automationPositions)
        .set({
          count: Math.max(0, remaining),
          status: closed ? "closed" : "open",
          exitReason: closed ? exit : pos.exitReason,
          sellOrderId: orderRow.id,
          saleProceedsCents:
            (pos.saleProceedsCents ?? 0) + placed.fillCount * proceedsPer,
          sellFeeCents: (pos.sellFeeCents ?? 0) + sellFeeTotal,
          realizedPnlCents: (pos.realizedPnlCents ?? 0) + chunkPnl,
          closedAt: closed ? new Date() : null,
        })
        .where(eq(automationPositions.id, pos.id));

      pos.count = Math.max(0, remaining);
      pos.status = closed ? "closed" : "open";
      sells++;

      await logAction(runId, {
        kind: "sell",
        ticker: pos.ticker,
        eventTicker: pos.eventTicker,
        side: pos.side,
        count: placed.fillCount,
        priceCents: proceedsPer,
        positionId: pos.id,
        orderId: orderRow.id,
        reason: `${exit === "take_profit" ? "Take-profit" : "Stop-loss"}: bought at ${pos.avgCostCents}¢, sold ${placed.fillCount}/${sellCount} at ${proceedsPer}¢ → P&L ${formatCents(chunkPnl)}${closed ? "" : " (partial — position stays open)"}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(automationPositions)
        .set({ status: "open" })
        .where(and(eq(automationPositions.id, pos.id), eq(automationPositions.status, "closing")));
      await logAction(runId, {
        kind: "error",
        ticker: pos.ticker,
        eventTicker: pos.eventTicker,
        positionId: pos.id,
        reason: `Sell attempt failed: ${message}`,
      });
    }
  }
  return sells;
}

// --- Buy pass --------------------------------------------------------------------

interface BuyCandidate {
  enriched: EnrichedEvent;
  suggestion: SuggestedAction;
  leadDays: number | null;
}

/** Rebuy cooldown after a stop-loss — ends the stop→rebuy→stop churn loop. */
const STOP_LOSS_COOLDOWN_HOURS = 6;

/** Realized P&L (cents) across positions closed in the trailing 24 hours. */
async function trailing24hRealizedPnl(): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(realized_pnl_cents), 0) AS pnl
    FROM automation_positions
    WHERE closed_at > now() - interval '24 hours'
      AND section = 'weather'
  `);
  return Number(res.rows[0]?.pnl ?? 0);
}

/** Tickers stop-lossed within the cooldown window — do not rebuy yet. */
async function recentStopLossTickers(): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT DISTINCT ticker
    FROM automation_positions
    WHERE exit_reason = 'stop_loss'
      AND section = 'weather'
      AND closed_at > now() - (${STOP_LOSS_COOLDOWN_HOURS} || ' hours')::interval
  `);
  return new Set(res.rows.map((r) => String((r as { ticker: string }).ticker)));
}

function marketClosed(enriched: EnrichedEvent, ticker: string): boolean {
  const m = enriched.event.markets?.find((mm) => mm.ticker === ticker);
  if (!m) return true;
  return !!m.close_time && new Date(m.close_time) <= new Date();
}

async function buyPass(
  runId: number,
  settings: AutomationSettings,
  positions: OpenPosition[],
  kalshiByTicker: Map<string, number>,
  balanceCents: number | null,
): Promise<{ buys: number; candidates: number }> {
  const open = positions.filter((p) => p.status !== "closed" && p.count > 0);
  let budgetLeft = settings.budgetCents - deployedCents(open);
  let openCount = open.length;
  let balanceLeft = balanceCents;

  if (openCount >= settings.maxOpenPositions) {
    await logAction(runId, {
      kind: "info",
      reason: `Buy pass skipped: ${openCount}/${settings.maxOpenPositions} positions already open`,
    });
    return { buys: 0, candidates: 0 };
  }
  if (budgetLeft < 5) {
    await logAction(runId, {
      kind: "info",
      reason: `Buy pass skipped: budget exhausted (${formatCents(-Math.max(0, -budgetLeft))} of ${formatCents(settings.budgetCents)} free)`.replace("+", ""),
    });
    return { buys: 0, candidates: 0 };
  }

  // Cheapest possible viable trade under the price floor — if the account
  // can't cover it there is nothing to do (and no reason to burn AI reviews).
  if (
    balanceCents !== null &&
    balanceCents < settings.minPriceCents + 2
  ) {
    await logAction(runId, {
      kind: "info",
      reason: `Buy pass skipped: balance ${formatCents(balanceCents).replace("+", "")} cannot cover a single contract at the ${settings.minPriceCents}¢ price floor`,
    });
    return { buys: 0, candidates: 0 };
  }

  // Circuit breaker: after a bad 24h stop opening new risk; exits still run.
  if (settings.maxDailyLossCents > 0) {
    const pnl24h = await trailing24hRealizedPnl();
    if (pnl24h <= -settings.maxDailyLossCents) {
      await logAction(runId, {
        kind: "info",
        reason: `Buy pass halted by circuit breaker: realized P&L over the last 24h is ${formatCents(pnl24h)} (limit -${formatCents(settings.maxDailyLossCents).replace("+", "")})`,
      });
      return { buys: 0, candidates: 0 };
    }
  }

  // Tickers the bot must not touch: any open bot position (either side —
  // buying the opposite side would net-close it), any manual Kalshi holding,
  // or anything stop-lossed within the cooldown window.
  const heldTickers = new Set(open.map((p) => p.ticker));
  const cooldownTickers = await recentStopLossTickers();

  const rows = await getOpenEventsFromDb();
  const enrichedEvents = await buildEnrichedEvents(rows);

  const candidates: BuyCandidate[] = [];
  for (const enriched of enrichedEvents) {
    const leadDays = enriched.prediction?.leadDays ?? null;
    if (settings.targetDateMode === "tomorrow_only" && leadDays !== 1) continue;

    const likelihoods = enriched.prediction?.marketLikelihoods ?? [];
    const obsByTicker = new Map(likelihoods.map((ll) => [ll.ticker, ll.obsBacked === true]));

    for (const s of computeSuggestedActions(enriched, 10)) {
      if (s.score < settings.minScore) continue;
      if (s.evPerContract < settings.minEv) continue;
      if (s.winProb < settings.minWinProb) continue;
      // Cheap-lottery guard: entries under the floor were 6/35 for −$5.27 live
      if (Math.round(s.price * 100) < settings.minPriceCents) continue;
      // Disagreement guard: when the model claims far more than the market
      // will pay, the market has been the one that's right. marketProb is
      // P(YES) — flip it for NO picks before comparing to the side winProb.
      if (s.marketProb !== null && s.marketProb !== undefined) {
        const sideMarketProb = s.side === "yes" ? s.marketProb : 1 - s.marketProb;
        if (s.winProb - sideMarketProb > settings.maxProbGap) continue;
      }
      // Hourly temp series settle on a single hour's reading the daily model
      // can't price — excluded at the predictor, kept here as backstop
      if (/^KXTEMP[A-Z]*H-/.test(s.ticker)) continue;
      if (settings.obsBackedOnly && !obsByTicker.get(s.ticker)) continue;
      if (marketClosed(enriched, s.ticker)) continue;
      if (heldTickers.has(s.ticker)) continue;
      if (cooldownTickers.has(s.ticker)) continue;
      if ((kalshiByTicker.get(s.ticker) ?? 0) !== 0) continue;
      candidates.push({ enriched, suggestion: s, leadDays });
    }
  }

  // Tomorrow's events first (when preferred), then by risk-adjusted score
  candidates.sort((a, b) => {
    if (settings.targetDateMode === "prefer_tomorrow") {
      const at = a.leadDays === 1 ? 1 : 0;
      const bt = b.leadDays === 1 ? 1 : 0;
      if (at !== bt) return bt - at;
    }
    return b.suggestion.score - a.suggestion.score;
  });

  if (candidates.length === 0) {
    await logAction(runId, {
      kind: "info",
      reason: "No suggestions passed the buy filters this run",
    });
    return { buys: 0, candidates: 0 };
  }

  const forecastCache = new Map<string, Awaited<ReturnType<typeof getForecast>> | null>();
  const contractCap = maxOrderContracts();
  const seenThisRun = new Set<string>();
  let buys = 0;

  for (const { enriched, suggestion: s, leadDays } of candidates) {
    if (buys >= settings.maxBuysPerRun) break;
    if (openCount >= settings.maxOpenPositions) break;
    if (seenThisRun.has(s.ticker)) continue;

    const eventTicker = enriched.event.event_ticker;
    try {
      // --- Sizing first: never spend an AI review on a trade we can't afford ---
      const askCents = Math.round(s.price * 100);
      const maxPriceCents = Math.min(99, askCents + BUY_BUFFER_CENTS);
      const feeCents = Math.round(kalshiFeePerContract(maxPriceCents / 100) * 100);
      let n = sizeContracts(
        maxPriceCents,
        feeCents,
        settings.maxPerTradeCents,
        budgetLeft,
        contractCap,
      );
      if (balanceLeft !== null) {
        n = Math.min(n, Math.floor(balanceLeft / (maxPriceCents + feeCents)));
      }
      if (n < 1) {
        await logAction(runId, {
          kind: "skip",
          ticker: s.ticker,
          eventTicker,
          side: s.side,
          priceCents: askCents,
          reason: `Cannot afford 1 contract at ${maxPriceCents}¢+${feeCents}¢ fee (budget left ${formatCents(budgetLeft).replace("+", "")}, balance ${balanceLeft !== null ? formatCents(balanceLeft).replace("+", "") : "unknown"})`,
        });
        continue;
      }

      // --- AI review gate (fail closed) ---
      if (!isAiConfigured()) {
        await logAction(runId, {
          kind: "skip",
          ticker: s.ticker,
          eventTicker,
          side: s.side,
          reason: "ANTHROPIC_API_KEY not configured — AI review gate blocks all buys",
        });
        break;
      }
      const cityCode = enriched.cityCode;
      let forecast = cityCode ? forecastCache.get(cityCode) : null;
      if (cityCode && forecast === undefined) {
        forecast = await getForecast(CITY_MAP[cityCode]).catch(() => null);
        forecastCache.set(cityCode, forecast);
      }
      const review = await reviewSuggestions(enriched, forecast ?? null);
      const verdict = review.verdicts.find(
        (v) => v.ticker === s.ticker && v.side === s.side,
      );
      if (!verdict || verdict.verdict !== "keep" || verdict.confidence < settings.minAiConfidence) {
        await logAction(runId, {
          kind: "skip",
          ticker: s.ticker,
          eventTicker,
          side: s.side,
          priceCents: askCents,
          reason: verdict
            ? `AI review: ${verdict.verdict} (confidence ${Math.round(verdict.confidence * 100)}%) — ${verdict.reason}`
            : "AI review returned no verdict for this pick",
        });
        continue;
      }

      const reserved = n * (maxPriceCents + feeCents);
      budgetLeft -= reserved; // conservative: reserve before the API call
      seenThisRun.add(s.ticker);

      // --- Suggestion snapshot (audit + later grading) ---
      let suggestionId: number | null = null;
      try {
        const [row] = await db
          .insert(suggestions)
          .values({
            eventTicker,
            marketTicker: s.ticker,
            side: s.side,
            kind: s.kind,
            source: "auto",
            price: s.price,
            forecastProb: s.forecastProb,
            blendedProb: s.blendedProb,
            winProb: s.winProb,
            marketProb: s.marketProb,
            feePerContract: s.feePerContract,
            evPerContract: s.evPerContract,
            score: s.score,
            volume24h: s.volume24h,
            cityCode: enriched.cityCode,
            section: "weather",
            metric: enriched.subcategory,
            targetDate: enriched.prediction?.targetDate ?? null,
            leadDays,
            aiVerdict: verdict.verdict,
            aiConfidence: verdict.confidence,
          })
          .returning({ id: suggestions.id });
        suggestionId = row?.id ?? null;
      } catch (err) {
        console.error("[autoTrade] failed to snapshot suggestion:", err);
      }

      // --- Place the order ---
      const clientOrderId = randomUUID();
      const [orderRow] = await db
        .insert(orders)
        .values({
          clientOrderId,
          ticker: s.ticker,
          eventTicker,
          side: s.side,
          action: "buy",
          type: "market",
          count: n,
          maxCostCents: n * maxPriceCents,
          status: "pending",
          source: "auto",
          section: "weather",
          suggestionId,
        })
        .returning({ id: orders.id });

      const placed = await createOrder({
        ticker: s.ticker,
        clientOrderId,
        side: s.side,
        count: n,
        maxPriceCents,
      });

      await db
        .update(orders)
        .set({
          status: placed.status,
          kalshiOrderId: placed.orderId,
          avgFillPriceCents: placed.avgFillPriceCents,
          fillCount: placed.fillCount,
          avgFeeCents: placed.avgFeeCents,
          response: placed.raw as Record<string, unknown>,
        })
        .where(eq(orders.id, orderRow.id));

      if (placed.fillCount === 0) {
        budgetLeft += reserved; // nothing bought — release the reservation
        await logAction(runId, {
          kind: "skip",
          ticker: s.ticker,
          eventTicker,
          side: s.side,
          priceCents: askCents,
          orderId: orderRow.id,
          reason: `IOC buy at ${maxPriceCents}¢ did not fill (ask moved above the cap)`,
        });
        continue;
      }

      const fillPrice = placed.avgFillPriceCents ?? maxPriceCents;
      const feePer = placed.avgFeeCents ?? feeCents;
      const [posRow] = await db
        .insert(automationPositions)
        .values({
          ticker: s.ticker,
          eventTicker,
          side: s.side,
          count: placed.fillCount,
          avgCostCents: fillPrice,
          buyFeeCents: feePer,
          openOrderId: orderRow.id,
          suggestionId,
          status: "open",
          cityCode: enriched.cityCode,
          section: "weather",
          metric: enriched.subcategory,
          targetDate: enriched.prediction?.targetDate ?? null,
        })
        .returning({ id: automationPositions.id });

      // Release the part of the reservation that wasn't spent
      const spent = placed.fillCount * (fillPrice + feePer);
      budgetLeft += Math.max(0, reserved - spent);
      if (balanceLeft !== null) balanceLeft -= spent;
      buys++;
      openCount++;

      await logAction(runId, {
        kind: "buy",
        ticker: s.ticker,
        eventTicker,
        side: s.side,
        count: placed.fillCount,
        priceCents: fillPrice,
        orderId: orderRow.id,
        positionId: posRow?.id,
        reason: `Bought ${placed.fillCount}/${n} ${s.side.toUpperCase()} at ${fillPrice}¢ (EV ${Math.round(s.evPerContract * 100)}¢/contract, win ${Math.round(s.winProb * 100)}%, AI keep @ ${Math.round(verdict.confidence * 100)}%${leadDays === 1 ? ", tomorrow" : ""}) — ${s.kind} pick`,
        data: { rationale: s.rationale, aiReason: verdict.reason },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logAction(runId, {
        kind: "error",
        ticker: s.ticker,
        eventTicker,
        side: s.side,
        reason: `Buy attempt failed: ${message}`,
      });
    }
  }

  return { buys, candidates: candidates.length };
}

// --- Orchestrator ------------------------------------------------------------------

export async function runAutoTrade(trigger: "cron" | "manual"): Promise<RunSummary> {
  const summary: RunSummary = {
    runId: null,
    status: "skipped",
    candidates: 0,
    buys: 0,
    sells: 0,
  };

  if (!isTradingConfigured()) {
    summary.reason = "Kalshi trading is not configured";
    return summary;
  }
  if (runInFlight) {
    summary.reason = "A run is already in progress (in-process)";
    return summary;
  }

  const settings = await getAutomationSettings();
  if (!settings.enabled && trigger === "cron") {
    summary.reason = "Automation is disabled";
    return summary;
  }

  if (!(await acquireRunLease())) {
    summary.reason = "A run is already in progress (lease held)";
    return summary;
  }

  runInFlight = true;
  let runId: number | null = null;
  try {
    const [runRow] = await db
      .insert(automationRuns)
      .values({ trigger, status: "running", section: "weather" })
      .returning({ id: automationRuns.id });
    runId = runRow.id;
    summary.runId = runId;

    let balanceCents: number | null = null;
    try {
      balanceCents = (await getBalance()).balance;
    } catch (err) {
      console.warn("[autoTrade] balance fetch failed:", err);
    }

    let kalshiByTicker = new Map<string, number>();
    try {
      const kalshiPositions = await getPositions();
      kalshiByTicker = new Map(kalshiPositions.map((p) => [p.ticker, p.position]));
    } catch (err) {
      // Without Kalshi's view of the book we can't safely sell or dedup buys
      throw new Error(
        `Could not fetch Kalshi positions: ${err instanceof Error ? err.message : err}`,
      );
    }

    const positions = await getOpenPositions();
    await reconcileSettled(runId, positions);

    summary.sells = await sellPass(runId, settings, positions, kalshiByTicker);

    const { buys, candidates } = await buyPass(
      runId,
      settings,
      positions,
      kalshiByTicker,
      balanceCents,
    );
    summary.buys = buys;
    summary.candidates = candidates;
    summary.status = "ok";

    const finalPositions = await getOpenPositions();
    await db
      .update(automationRuns)
      .set({
        status: "ok",
        balanceCents,
        deployedCents: deployedCents(finalPositions),
        candidates,
        buys,
        sells: summary.sells,
        // DB clock, not app clock — startedAt uses defaultNow() and the local
        // clock has been observed >1 min behind the DB server
        finishedAt: sql`now()`,
      })
      .where(eq(automationRuns.id, runId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.status = "error";
    summary.error = message;
    console.error("[autoTrade] run failed:", err);
    if (runId !== null) {
      await db
        .update(automationRuns)
        .set({ status: "error", error: message, finishedAt: sql`now()` })
        .where(eq(automationRuns.id, runId))
        .catch(() => {});
    }
  } finally {
    runInFlight = false;
    await releaseRunLease().catch(() => {});
  }

  return summary;
}
