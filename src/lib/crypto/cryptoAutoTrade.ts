import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { automationPositions, automationRuns, orders, suggestions } from "@/db/schema";
import {
  createOrder,
  getBalance,
  getPositions,
  isTradingConfigured,
  maxOrderContracts,
} from "@/lib/kalshiTrade";
import {
  computeSuggestedActions,
  kalshiFeePerContract,
  SuggestedAction,
} from "@/lib/suggest";
import { isAiConfigured } from "@/lib/analyze";
import {
  acquireRunLease,
  BUY_BUFFER_CENTS,
  deployedCents,
  formatCents,
  getOpenPositions,
  logAction,
  OpenPosition,
  reconcileSettled,
  releaseRunLease,
  sellPass,
  sizeContracts,
} from "@/lib/tradeCommon";
import { ASSET_MAP } from "@/lib/crypto/assets";
import { getOpenCryptoEventsFromDb } from "@/lib/crypto/cryptoSync";
import {
  buildEnrichedCryptoEvents,
  CryptoAssetContext,
} from "@/lib/crypto/cryptoEnrich";
import { getSpot } from "@/lib/crypto/spot";
import { computeRealizedVols, finalSigma } from "@/lib/crypto/vol";
import { getRecentCandles } from "@/lib/crypto/spot";
import { priceStrikeProb } from "@/lib/crypto/cryptoPredictor";
import { getCryptoVolCalibration } from "@/lib/crypto/cryptoVolCalibration";
import {
  CryptoAutomationSettings,
  getCryptoAutomationSettings,
} from "@/lib/crypto/cryptoSettings";
import { reviewCryptoSuggestions } from "@/lib/crypto/cryptoReview";
import { EnrichedEvent, KalshiMarket } from "@/types";
import { RunSummary } from "@/lib/autoTrade";

/**
 * The crypto automation engine — mirrors runAutoTrade() with crypto-specific
 * risk guards on top of the shared v2 set:
 * - stale-spot fail-closed halt (no fresh price → no new risk)
 * - vol-spike halt per asset (30m realized vol >> 24h → expected move is
 *   unknown, model σ untrustworthy)
 * - τ window (never buy too far from, or too close to, settlement)
 * - one position per event ladder (bracket strikes are perfectly correlated)
 * - per-asset concurrency cap + per-ASSET stop-loss cooldown (hourly tickers
 *   churn too fast for ticker-level cooldown to bite)
 * - side-specific bid/ask spread guard
 * Stop-loss suppression recomputes the model win prob from LIVE spot instead
 * of snapshots — crypto probabilities go stale in minutes, not hours.
 */

const LEASE_KEY = "crypto_auto_trade_lease";
/** Per-asset rebuy cooldown after a stop-loss. */
const STOP_LOSS_COOLDOWN_MINUTES = 60;

let runInFlight = false;

// --- Live model win-prob (stop-loss suppression guard) -------------------------

/**
 * Recompute P(held side wins) from live spot + current σ for one market.
 * Null (⇒ no suppression, stop-loss fires) when anything is unavailable.
 */
async function liveCryptoWinProb(
  ticker: string,
  side: string,
  marketsByTicker: Map<string, { market: KalshiMarket; asset: string }>,
): Promise<number | null> {
  const entry = marketsByTicker.get(ticker);
  if (!entry) return null;
  const asset = ASSET_MAP[entry.asset];
  if (!asset) return null;
  try {
    const closeMs = entry.market.close_time
      ? new Date(entry.market.close_time).getTime()
      : NaN;
    const tauHours = (closeMs - Date.now()) / 3_600_000;
    if (!Number.isFinite(tauHours) || tauHours <= 0) return null;

    const [spot, candles, calibration] = await Promise.all([
      getSpot(asset),
      getRecentCandles(asset, 1440),
      getCryptoVolCalibration(),
    ]);
    const rvs = computeRealizedVols(candles, Date.now());
    const sigma = finalSigma(rvs, null, tauHours, calibration);
    if (!sigma) return null;

    const pYes = priceStrikeProb(spot.price, entry.market, sigma.sigmaAnnual, tauHours);
    if (pYes === null) return null;
    return side === "yes" ? pYes : 1 - pYes;
  } catch (err) {
    console.warn(`[crypto/autoTrade] live win-prob failed for ${ticker}:`, err);
    return null;
  }
}

// --- Buy-pass helpers ------------------------------------------------------------

/** Assets stop-lossed within the cooldown window — no new buys on them yet. */
async function recentStopLossAssets(): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT DISTINCT asset
    FROM automation_positions
    WHERE exit_reason = 'stop_loss'
      AND section = 'crypto'
      AND asset IS NOT NULL
      AND closed_at > now() - (${STOP_LOSS_COOLDOWN_MINUTES} || ' minutes')::interval
  `);
  return new Set(res.rows.map((r) => String((r as { asset: string }).asset)));
}

/** Realized P&L (cents) across crypto positions closed in the trailing 24h. */
async function trailing24hRealizedPnl(): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(realized_pnl_cents), 0) AS pnl
    FROM automation_positions
    WHERE closed_at > now() - interval '24 hours'
      AND section = 'crypto'
  `);
  return Number(res.rows[0]?.pnl ?? 0);
}

interface CryptoBuyCandidate {
  enriched: EnrichedEvent;
  suggestion: SuggestedAction;
  market: KalshiMarket;
  tauHours: number;
}

function sideBook(market: KalshiMarket, side: "yes" | "no"): { askC: number; bidC: number } {
  const ask = parseFloat(
    (side === "yes" ? market.yes_ask_dollars : market.no_ask_dollars) || "0",
  );
  const bid = parseFloat(
    (side === "yes" ? market.yes_bid_dollars : market.no_bid_dollars) || "0",
  );
  return { askC: Math.round(ask * 100), bidC: Math.round(bid * 100) };
}

async function cryptoBuyPass(
  runId: number,
  settings: CryptoAutomationSettings,
  positions: OpenPosition[],
  kalshiByTicker: Map<string, number>,
  balanceCents: number | null,
  enrichedEvents: EnrichedEvent[],
  contexts: Record<string, CryptoAssetContext>,
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
      reason: `Buy pass skipped: budget exhausted (${formatCents(settings.budgetCents)} deployed)`.replace("+", ""),
    });
    return { buys: 0, candidates: 0 };
  }
  if (balanceCents !== null && balanceCents < settings.minPriceCents + 2) {
    await logAction(runId, {
      kind: "info",
      reason: `Buy pass skipped: balance ${formatCents(balanceCents).replace("+", "")} cannot cover a single contract at the ${settings.minPriceCents}¢ price floor`,
    });
    return { buys: 0, candidates: 0 };
  }

  // Circuit breaker (crypto book only): sells keep running.
  if (settings.maxDailyLossCents > 0) {
    const pnl24h = await trailing24hRealizedPnl();
    if (pnl24h <= -settings.maxDailyLossCents) {
      await logAction(runId, {
        kind: "info",
        reason: `Buy pass halted by circuit breaker: crypto realized P&L over the last 24h is ${formatCents(pnl24h)} (limit -${formatCents(settings.maxDailyLossCents).replace("+", "")})`,
      });
      return { buys: 0, candidates: 0 };
    }
  }

  // Stale-spot guard — FAIL CLOSED: no trustworthy price, no new risk.
  const now = Date.now();
  const assetsInPlay = Object.keys(contexts);
  if (assetsInPlay.length === 0) {
    await logAction(runId, {
      kind: "info",
      reason: "Buy pass halted: no spot data available from any feed (fail closed)",
    });
    return { buys: 0, candidates: 0 };
  }
  const staleAssets = new Set(
    assetsInPlay.filter(
      (a) => (now - contexts[a].spot.ts) / 1000 > settings.maxSpotAgeSec,
    ),
  );
  if (staleAssets.size === assetsInPlay.length) {
    await logAction(runId, {
      kind: "info",
      reason: `Buy pass halted: all spot feeds older than ${settings.maxSpotAgeSec}s (fail closed)`,
    });
    return { buys: 0, candidates: 0 };
  }

  // Vol-spike guard per asset: 30m realized vol far above 24h ⇒ σ unreliable.
  const volSpikedAssets = new Set<string>();
  for (const a of assetsInPlay) {
    const { rv30m, rv24h } = contexts[a].rvs;
    if (rv30m !== null && rv24h !== null && rv30m > settings.volSpikeMult * rv24h) {
      volSpikedAssets.add(a);
      await logAction(runId, {
        kind: "info",
        reason: `${a} buys halted: 30m realized vol ${(rv30m * 100).toFixed(0)}% > ${settings.volSpikeMult}× 24h vol ${(rv24h * 100).toFixed(0)}% (vol spike — expected move unreliable)`,
      });
    }
  }

  const cooldownAssets = await recentStopLossAssets();
  const heldTickers = new Set(open.map((p) => p.ticker));
  const heldEventTickers = new Set(open.map((p) => p.eventTicker));
  const openPerAsset = new Map<string, number>();
  for (const pos of open) {
    if (pos.asset) openPerAsset.set(pos.asset, (openPerAsset.get(pos.asset) ?? 0) + 1);
  }

  const candidates: CryptoBuyCandidate[] = [];
  for (const enriched of enrichedEvents) {
    const prediction = enriched.prediction;
    const asset = enriched.asset;
    if (!prediction?.marketLikelihoods || !asset) continue;
    if (staleAssets.has(asset) || volSpikedAssets.has(asset)) continue;
    if (cooldownAssets.has(asset)) continue;
    if (heldEventTickers.has(enriched.event.event_ticker)) continue;

    const tauHours = prediction.tauHours;
    if (tauHours === undefined) continue;
    if (tauHours > settings.maxTauHours || tauHours * 60 < settings.minTauMinutes) continue;

    const marketByTicker = new Map(
      (enriched.event.markets ?? []).map((m) => [m.ticker, m]),
    );
    const obsByTicker = new Map(
      prediction.marketLikelihoods.map((ll) => [ll.ticker, ll.obsBacked === true]),
    );

    for (const s of computeSuggestedActions(enriched, 10)) {
      if (s.score < settings.minScore) continue;
      if (s.evPerContract < settings.minEv) continue;
      if (s.winProb < settings.minWinProb) continue;
      if (Math.round(s.price * 100) < settings.minPriceCents) continue;
      if (s.marketProb !== null && s.marketProb !== undefined) {
        const sideMarketProb = s.side === "yes" ? s.marketProb : 1 - s.marketProb;
        if (s.winProb - sideMarketProb > settings.maxProbGap) continue;
      }
      if (settings.spotBackedOnly && !obsByTicker.get(s.ticker)) continue;

      const market = marketByTicker.get(s.ticker);
      if (!market) continue;
      if (market.close_time && new Date(market.close_time) <= new Date()) continue;

      // Side-specific spread guard — wide books mean the posted ask is a trap
      const { askC, bidC } = sideBook(market, s.side);
      if (askC <= 0 || askC - bidC > settings.maxSpreadCents) continue;

      if (heldTickers.has(s.ticker)) continue;
      if ((kalshiByTicker.get(s.ticker) ?? 0) !== 0) continue;

      candidates.push({ enriched, suggestion: s, market, tauHours });
    }
  }

  candidates.sort((a, b) => b.suggestion.score - a.suggestion.score);

  if (candidates.length === 0) {
    await logAction(runId, {
      kind: "info",
      reason: "No suggestions passed the crypto buy filters this run",
    });
    return { buys: 0, candidates: 0 };
  }

  const contractCap = maxOrderContracts();
  const boughtEvents = new Set<string>();
  let buys = 0;

  for (const { enriched, suggestion: s, tauHours } of candidates) {
    if (buys >= settings.maxBuysPerRun) break;
    if (openCount >= settings.maxOpenPositions) break;

    const eventTicker = enriched.event.event_ticker;
    const asset = enriched.asset!;
    if (boughtEvents.has(eventTicker)) continue; // one position per ladder
    if ((openPerAsset.get(asset) ?? 0) >= settings.maxPerAsset) continue;

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
      const review = await reviewCryptoSuggestions(enriched, contexts[asset] ?? null);
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
      budgetLeft -= reserved;
      boughtEvents.add(eventTicker);

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
            cityCode: null,
            section: "crypto",
            asset,
            metric: "crypto_price",
            targetDate: enriched.prediction?.targetDate ?? null,
            leadDays: null,
            tauHours,
            aiVerdict: verdict.verdict,
            aiConfidence: verdict.confidence,
          })
          .returning({ id: suggestions.id });
        suggestionId = row?.id ?? null;
      } catch (err) {
        console.error("[crypto/autoTrade] failed to snapshot suggestion:", err);
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
          section: "crypto",
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
        budgetLeft += reserved;
        boughtEvents.delete(eventTicker);
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
          cityCode: null,
          section: "crypto",
          asset,
          metric: "crypto_price",
          targetDate: enriched.prediction?.targetDate ?? null,
        })
        .returning({ id: automationPositions.id });

      const spent = placed.fillCount * (fillPrice + feePer);
      budgetLeft += Math.max(0, reserved - spent);
      if (balanceLeft !== null) balanceLeft -= spent;
      buys++;
      openCount++;
      openPerAsset.set(asset, (openPerAsset.get(asset) ?? 0) + 1);

      await logAction(runId, {
        kind: "buy",
        ticker: s.ticker,
        eventTicker,
        side: s.side,
        count: placed.fillCount,
        priceCents: fillPrice,
        orderId: orderRow.id,
        positionId: posRow?.id,
        reason: `Bought ${placed.fillCount}/${n} ${s.side.toUpperCase()} at ${fillPrice}¢ (EV ${Math.round(s.evPerContract * 100)}¢/contract, win ${Math.round(s.winProb * 100)}%, AI keep @ ${Math.round(verdict.confidence * 100)}%, settles in ${Math.round(tauHours * 60)}m) — ${s.kind} pick`,
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

// --- Orchestrator --------------------------------------------------------------------

export async function runCryptoAutoTrade(trigger: "cron" | "manual"): Promise<RunSummary> {
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

  const settings = await getCryptoAutomationSettings();
  if (!settings.enabled && trigger === "cron") {
    summary.reason = "Crypto automation is disabled";
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
      .values({ trigger, status: "running", section: "crypto" })
      .returning({ id: automationRuns.id });
    runId = runRow.id;
    summary.runId = runId;

    let balanceCents: number | null = null;
    try {
      balanceCents = (await getBalance()).balance;
    } catch (err) {
      console.warn("[crypto/autoTrade] balance fetch failed:", err);
    }

    let kalshiByTicker = new Map<string, number>();
    try {
      const kalshiPositions = await getPositions();
      kalshiByTicker = new Map(kalshiPositions.map((p) => [p.ticker, p.position]));
    } catch (err) {
      throw new Error(
        `Could not fetch Kalshi positions: ${err instanceof Error ? err.message : err}`,
      );
    }

    const positions = await getOpenPositions("crypto");
    await reconcileSettled(runId, positions, "crypto");

    // One enrichment pass feeds the sell guard AND the buy pass
    const rows = await getOpenCryptoEventsFromDb();
    const { events: enrichedEvents, contexts } = await buildEnrichedCryptoEvents(rows);
    const marketsByTicker = new Map<string, { market: KalshiMarket; asset: string }>();
    for (const e of enrichedEvents) {
      if (!e.asset) continue;
      for (const m of e.event.markets ?? []) {
        marketsByTicker.set(m.ticker, { market: m, asset: e.asset });
      }
    }

    summary.sells = await sellPass(runId, settings, positions, kalshiByTicker, {
      section: "crypto",
      modelWinProb: (ticker, side) => liveCryptoWinProb(ticker, side, marketsByTicker),
    });

    const { buys, candidates } = await cryptoBuyPass(
      runId,
      settings,
      positions,
      kalshiByTicker,
      balanceCents,
      enrichedEvents,
      contexts,
    );
    summary.buys = buys;
    summary.candidates = candidates;
    summary.status = "ok";

    const finalPositions = await getOpenPositions("crypto");
    await db
      .update(automationRuns)
      .set({
        status: "ok",
        balanceCents,
        deployedCents: deployedCents(finalPositions),
        candidates,
        buys,
        sells: summary.sells,
        finishedAt: sql`now()`,
      })
      .where(eq(automationRuns.id, runId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.status = "error";
    summary.error = message;
    console.error("[crypto/autoTrade] run failed:", err);
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
