import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  automationPositions,
  automationRuns,
  orders,
  predictionSnapshots,
  suggestions,
} from "@/db/schema";
import {
  createOrder,
  getBalance,
  getPositions,
  isTradingConfigured,
  maxOrderContracts,
} from "@/lib/kalshiTrade";
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
import {
  acquireRunLease,
  BUY_BUFFER_CENTS,
  deployedCents,
  formatCents,
  getOpenPositions,
  getTrailingGuardState,
  logAction,
  OpenPosition,
  reconcileSettled,
  releaseRunLease,
  sellPass,
  sizeContracts,
} from "@/lib/tradeCommon";
import { EXCLUDED_WEATHER_SERIES } from "@/lib/weatherSeries";
import { EnrichedEvent } from "@/types";

// Pure decision helpers moved to tradeCommon.ts (shared with the crypto
// bot); re-exported so existing imports and tests keep working.
export {
  evaluateExit,
  maySuppressStopLoss,
  sizeContracts,
  type ExitReason,
} from "@/lib/tradeCommon";

/**
 * The weather automation engine: one runAutoTrade() call per external cron
 * hit (or manual "Run now"). Sells first to free budget, then buys the best
 * AI-approved suggestions. Every decision — including skips — is written to
 * automation_actions so the /weather/automation page can show why the bot
 * acted. Section-agnostic plumbing lives in tradeCommon.ts.
 */

const LEASE_KEY = "auto_trade_lease";

export interface RunSummary {
  runId: number | null;
  status: "ok" | "error" | "skipped";
  reason?: string;
  candidates: number;
  buys: number;
  sells: number;
  error?: string;
}

let runInFlight = false;

// --- Weather model win-prob source (stop-loss suppression guard) --------------

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

  // Slow-bleed guard: a config that loses a little on every settle never
  // trips the 24h breaker — judge the last N closed trades instead.
  const guard = await getTrailingGuardState("weather", settings);
  if (guard.tripped) {
    await logAction(runId, {
      kind: "info",
      reason: `Buy pass halted by trailing-loss guard: last ${guard.trades} closed trades realized ${formatCents(guard.pnlCents)} (limit -${formatCents(settings.trailingGuardLossCents).replace("+", "")})`,
    });
    return { buys: 0, candidates: 0 };
  }

  // Tickers the bot must not touch: any open bot position (either side —
  // buying the opposite side would net-close it), any manual Kalshi holding,
  // or anything stop-lossed within the cooldown window.
  const heldTickers = new Set(open.map((p) => p.ticker));
  const cooldownTickers = await recentStopLossTickers();

  const rows = await getOpenEventsFromDb();
  const enrichedEvents = await buildEnrichedEvents(rows);

  const candidates: BuyCandidate[] = [];
  const excludedCities = new Set(settings.excludeCities);
  for (const enriched of enrichedEvents) {
    const leadDays = enriched.prediction?.leadDays ?? null;
    if (settings.targetDateMode === "tomorrow_only" && leadDays !== 1) continue;
    // Strict lead gate — null leads (monthly/no-target series) are rejected
    // too, closing the hole that let KXRAIN monthlies through.
    if (
      settings.targetDateMode === "today_or_tomorrow" &&
      leadDays !== 0 &&
      leadDays !== 1
    ) {
      continue;
    }
    // Metric allowlist: the backtested universe is temperature-only.
    if (!settings.metrics.includes(enriched.subcategory)) continue;
    // Per-city gate: persistently negative cities (see excludeCities docs)
    if (enriched.cityCode && excludedCities.has(enriched.cityCode)) continue;

    const likelihoods = enriched.prediction?.marketLikelihoods ?? [];
    const obsByTicker = new Map(likelihoods.map((ll) => [ll.ticker, ll.obsBacked === true]));

    for (const s of computeSuggestedActions(enriched, 10)) {
      if (s.score < settings.minScore) continue;
      if (s.evPerContract < settings.minEv) continue;
      if (s.winProb < settings.minWinProb) continue;
      // Cheap-lottery guard: entries under the floor were 6/35 for −$5.27 live
      if (Math.round(s.price * 100) < settings.minPriceCents) continue;
      if (Math.round(s.price * 100) > settings.maxPriceCents) continue;
      // Disagreement guard: when the model claims far more than the market
      // will pay, the market has been the one that's right. marketProb is
      // P(YES) — flip it for NO picks before comparing to the side winProb.
      if (s.marketProb !== null && s.marketProb !== undefined) {
        const sideMarketProb = s.side === "yes" ? s.marketProb : 1 - s.marketProb;
        if (s.winProb - sideMarketProb > settings.maxProbGap) continue;
      }
      // Series the model must never trade (hourly temps, TWC-settled rain/
      // holiday) — same exclusion list the backtest dataset uses.
      if (EXCLUDED_WEATHER_SERIES.test(s.ticker)) continue;
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
            decided: s.decided ?? null,
            obsBacked: s.obsBacked ?? null,
            blendW: s.blendWeight ?? null,
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

  if (!(await acquireRunLease(LEASE_KEY))) {
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

    const positions = await getOpenPositions("weather");
    await reconcileSettled(runId, positions, "weather");

    summary.sells = await sellPass(runId, settings, positions, kalshiByTicker, {
      section: "weather",
      modelWinProb: latestModelWinProb,
    });

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

    const finalPositions = await getOpenPositions("weather");
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
    await releaseRunLease(LEASE_KEY).catch(() => {});
  }

  return summary;
}
