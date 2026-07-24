import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { automationActions, automationPositions, orders, settlements } from "@/db/schema";
import { getEvent } from "@/lib/kalshi";
import { sellPosition } from "@/lib/kalshiTrade";
import { KalshiEvent, KalshiMarket } from "@/types";

/**
 * Section-agnostic automation plumbing shared by the weather bot
 * (autoTrade.ts) and the crypto bot (crypto/cryptoAutoTrade.ts): pure
 * exit/sizing helpers, the run lease, action logging, position bookkeeping,
 * settlement reconciliation, and the sell pass. Extracted mechanically from
 * autoTrade.ts — behavior is identical; weather-specific pieces (candidate
 * sourcing, model win-prob lookup) stay in the section engines and are
 * injected here as parameters.
 */

export const BUY_BUFFER_CENTS = 5; // aggressive-IOC buffer, same as manual route
export const SELL_BUFFER_CENTS = 3; // accept up to 3¢ under the quoted bid
export const LEASE_TTL_MS = 5 * 60 * 1000;
const STALE_PENDING_MS = 10 * 60 * 1000;

export type TradeSection = "weather" | "crypto";

// --- Pure decision helpers (unit-tested via autoTrade re-exports) ------------

export type ExitReason = "take_profit" | "stop_loss" | null;

export interface ExitSettings {
  takeProfitMode: "profit_pct" | "capture_pct";
  takeProfitValue: number;
  stopLossEnabled: boolean;
  stopLossPct: number;
}

/**
 * Should a position bought at costCents be exited at the current bidCents?
 * Take-profit wins over stop-loss when both would somehow trigger.
 */
export function evaluateExit(
  costCents: number,
  bidCents: number,
  settings: ExitSettings,
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

// --- Run lease (overlap protection) ------------------------------------------

/**
 * DB-level compare-and-set lease so overlapping cron hits (or a second
 * server instance) can't run two trading passes at once. Self-expires after
 * LEASE_TTL_MS in case a run dies without releasing. Each section uses its
 * own lease key so the weather and crypto bots never block each other.
 */
export async function acquireRunLease(leaseKey: string): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - LEASE_TTL_MS;
  const value = JSON.stringify({ ts: now });
  const res = await db.execute(sql`
    INSERT INTO sync_meta (key, value)
    VALUES (${leaseKey}, ${value}::jsonb)
    ON CONFLICT (key) DO UPDATE
      SET value = excluded.value, updated_at = now()
      WHERE COALESCE((sync_meta.value->>'ts')::bigint, 0) < ${cutoff}
    RETURNING key
  `);
  return (res.rowCount ?? res.rows.length) > 0;
}

export async function releaseRunLease(leaseKey: string): Promise<void> {
  const value = JSON.stringify({ ts: 0 });
  await db.execute(sql`
    UPDATE sync_meta SET value = ${value}::jsonb, updated_at = now()
    WHERE key = ${leaseKey}
  `);
}

// --- Logging helpers ------------------------------------------------------------

export type ActionEntry = {
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

export async function logAction(runId: number, entry: ActionEntry): Promise<void> {
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
    console.error("[tradeCommon] failed to log action:", err);
  }
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "+";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function bidCentsFor(market: KalshiMarket, side: string): number {
  const raw = side === "yes" ? market.yes_bid_dollars : market.no_bid_dollars;
  return Math.round(parseFloat(raw || "0") * 100);
}

// --- Budget / book helpers --------------------------------------------------------

export type OpenPosition = typeof automationPositions.$inferSelect;

export async function getOpenPositions(section: TradeSection): Promise<OpenPosition[]> {
  return db
    .select()
    .from(automationPositions)
    .where(
      and(
        inArray(automationPositions.status, ["open", "closing"]),
        eq(automationPositions.section, section),
      ),
    );
}

export function deployedCents(positions: OpenPosition[]): number {
  return positions.reduce(
    (sum, p) => sum + p.count * (p.avgCostCents + (p.buyFeeCents ?? 0)),
    0,
  );
}

// --- Slow-bleed guard ---------------------------------------------------------

export interface TrailingGuardSettings {
  trailingGuardTrades: number;
  trailingGuardLossCents: number;
}

export interface TrailingGuardState {
  trades: number;
  pnlCents: number;
  tripped: boolean;
}

/** Summed realized P&L over the last n closed positions for a section. */
export async function trailingSettledPnlCents(
  section: TradeSection,
  n: number,
): Promise<{ trades: number; pnlCents: number }> {
  const res = await db.execute(sql`
    SELECT COUNT(*) AS trades, COALESCE(SUM(realized_pnl_cents), 0) AS pnl
    FROM (
      SELECT realized_pnl_cents
      FROM automation_positions
      WHERE section = ${section} AND status = 'closed' AND closed_at IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT ${n}
    ) recent
  `);
  return {
    trades: Number(res.rows[0]?.trades ?? 0),
    pnlCents: Number(res.rows[0]?.pnl ?? 0),
  };
}

/**
 * Does the trailing window demand a buy halt? Only judges a full window —
 * a partial window (fewer closed trades than configured) never trips, so a
 * fresh book can't be halted by two early losers.
 */
export function trailingGuardTripped(
  trades: number,
  pnlCents: number,
  settings: TrailingGuardSettings,
): boolean {
  if (settings.trailingGuardTrades <= 0) return false;
  if (trades < settings.trailingGuardTrades) return false;
  return pnlCents <= -settings.trailingGuardLossCents;
}

/** Convenience wrapper: fetch the trailing window and evaluate the guard. */
export async function getTrailingGuardState(
  section: TradeSection,
  settings: TrailingGuardSettings,
): Promise<TrailingGuardState> {
  if (settings.trailingGuardTrades <= 0) {
    return { trades: 0, pnlCents: 0, tripped: false };
  }
  const { trades, pnlCents } = await trailingSettledPnlCents(
    section,
    settings.trailingGuardTrades,
  );
  return { trades, pnlCents, tripped: trailingGuardTripped(trades, pnlCents, settings) };
}

// --- Settlement reconciliation -------------------------------------------------------

/**
 * Close positions whose market has settled (the settlement jobs fill the
 * settlements table every scheduler tick). Also fails out stale pending auto
 * orders — IOC orders can't rest, so pending >10 min means the run died
 * mid-call.
 */
export async function reconcileSettled(
  runId: number,
  positions: OpenPosition[],
  section: TradeSection,
): Promise<void> {
  await db
    .update(orders)
    .set({ status: "failed", response: { error: "stale pending auto order" } })
    .where(
      and(
        eq(orders.source, "auto"),
        eq(orders.section, section),
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

// --- Sell pass ----------------------------------------------------------------------

export interface SellPassContext {
  section: TradeSection;
  /**
   * Latest model P(held side wins) for the stop-loss suppression guard.
   * Weather reads fresh prediction snapshots; crypto recomputes from live
   * spot. Return null when no trustworthy estimate exists (suppression is
   * then disabled and the stop-loss fires normally).
   */
  modelWinProb: (ticker: string, side: string) => Promise<number | null>;
}

export async function sellPass(
  runId: number,
  settings: ExitSettings,
  positions: OpenPosition[],
  kalshiByTicker: Map<string, number>,
  ctx: SellPassContext,
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
        const modelWin = await ctx.modelWinProb(pos.ticker, pos.side);
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
          section: ctx.section,
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
