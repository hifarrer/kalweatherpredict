import { priceStrikeProb } from "@/lib/crypto/cryptoPredictor";
import { blendProbability, kalshiFeePerContract } from "@/lib/suggest";
import { computeRealizedVols, finalSigma } from "@/lib/crypto/vol";
import { normalCdf } from "@/lib/stats";
import {
  CryptoModelParams,
  RealizedVols,
  TauBucket,
  tauBucket,
} from "@/lib/crypto/params";
import { BtDataset, BtEvent, BtKalshiCandle, BtSpotCandle } from "./btypes";

/**
 * Pure replay engine. Deliberately imports the production pricing pipeline
 * (priceStrikeProb, blendProbability, kalshiFeePerContract, vol estimators)
 * so the backtest exercises the exact code that trades live. Only the
 * position bookkeeping (entry/TP/SL/settle) is reimplemented here — the live
 * version lives inside the DB-coupled automation engine.
 */

// --- Raw steps (independent of model params except volMode/halfLife) --------

export interface RawStepMarket {
  ticker: string;
  strikeType: string;
  floor: number | null;
  cap: number | null;
  result: "yes" | "no";
  yesBid: number; // dollars
  yesAsk: number;
  cumVol: number; // contracts traded so far
}

export interface RawStep {
  eventIdx: number;
  asset: string;
  ts: number;
  tauHours: number;
  spot: number;
  rvs: RealizedVols;
  dvol: number | null;
  markets: RawStepMarket[];
}

export interface ReplayOptions {
  stepMin: number;
  maxTauHours: number;
  /** Skip steps closer to settlement than this (last candle is unreliable). */
  minTauMin: number;
  /** Book older than this at a step is considered stale and skipped. */
  maxBookAgeMin: number;
}

export const DEFAULT_REPLAY_OPTS: ReplayOptions = {
  stepMin: 5,
  maxTauHours: 6,
  minTauMin: 3,
  maxBookAgeMin: 10,
};

function lastIndexAtOrBefore<T>(arr: T[], ts: number, get: (t: T) => number): number {
  let lo = 0,
    hi = arr.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) <= ts) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Build per-step market/vol state for every event. Realized vols are the
 * expensive part and depend only on volMode/halfLife, so callers reuse raw
 * steps across model-parameter combos that share those.
 */
export function buildRawSteps(
  dataset: BtDataset,
  volParams: CryptoModelParams,
  opts: ReplayOptions = DEFAULT_REPLAY_OPTS,
): RawStep[] {
  const steps: RawStep[] = [];

  dataset.events.forEach((event, eventIdx) => {
    const spotCandles = dataset.spot[event.asset];
    const dvolPoints = dataset.dvol[event.asset] ?? [];
    if (!spotCandles || spotCandles.length === 0) return;

    // Per-market candle index + cumulative volume prefix
    const marketState = event.markets.map((m) => {
      const cum: number[] = new Array(m.candles.length);
      let acc = 0;
      m.candles.forEach((c, i) => {
        acc += c.vol;
        cum[i] = acc;
      });
      return { m, cum };
    });

    const start = event.closeTs - opts.maxTauHours * 3_600_000;
    const end = event.closeTs - opts.minTauMin * 60_000;

    for (let ts = start; ts <= end; ts += opts.stepMin * 60_000) {
      const spotIdx = lastIndexAtOrBefore(spotCandles, ts, (c) => c.ts);
      if (spotIdx < 0) continue;
      const spotCandle = spotCandles[spotIdx];
      if (ts - spotCandle.ts > 5 * 60_000) continue; // no fresh spot
      const spot = spotCandle.close;

      // 24h trailing window for realized vols
      const winStartIdx = lastIndexAtOrBefore(spotCandles, ts - 24.5 * 3_600_000, (c) => c.ts);
      const window = spotCandles.slice(Math.max(0, winStartIdx), spotIdx + 1);
      const rvs = computeRealizedVols(window, ts, volParams);

      const dvolIdx = lastIndexAtOrBefore(dvolPoints, ts, (p) => p.ts);
      const dvol = dvolIdx >= 0 ? dvolPoints[dvolIdx].dvol : null;

      const markets: RawStepMarket[] = [];
      for (const { m, cum } of marketState) {
        const ci = lastIndexAtOrBefore(m.candles, ts, (c: BtKalshiCandle) => c.ts);
        if (ci < 0) continue;
        const candle = m.candles[ci];
        if (ts - candle.ts > opts.maxBookAgeMin * 60_000) continue;
        if (candle.yesAsk <= 0 && candle.yesBid <= 0) continue;
        markets.push({
          ticker: m.ticker,
          strikeType: m.strikeType,
          floor: m.floor,
          cap: m.cap,
          result: m.result,
          yesBid: candle.yesBid,
          yesAsk: candle.yesAsk,
          cumVol: cum[ci],
        });
      }
      if (markets.length === 0) continue;

      steps.push({
        eventIdx,
        asset: event.asset,
        ts,
        tauHours: (event.closeTs - ts) / 3_600_000,
        spot,
        rvs,
        dvol,
        markets,
      });
    }
  });

  return steps;
}

// --- Model evaluation (σ + per-market probability) ---------------------------

export interface ScoredStep extends RawStep {
  sigmaAnnual: number;
  /** Per market, aligned with .markets: model P(YES). */
  modelProbs: (number | null)[];
}

export function scoreSteps(raw: RawStep[], params: CryptoModelParams): ScoredStep[] {
  const out: ScoredStep[] = [];
  for (const s of raw) {
    const sigma = finalSigma(s.rvs, s.dvol, s.tauHours, null, params);
    if (!sigma) continue;
    const modelProbs = s.markets.map((m) =>
      priceStrikeProb(
        s.spot,
        { strike_type: m.strikeType, floor_strike: m.floor, cap_strike: m.cap },
        sigma.sigmaAnnual,
        s.tauHours,
      ),
    );
    out.push({ ...s, sigmaAnnual: sigma.sigmaAnnual, modelProbs });
  }
  return out;
}

export interface ModelDiagnostics {
  n: number;
  brierModel: number;
  brierMarket: number;
  byBucket: Record<string, { n: number; brierModel: number; brierMarket: number }>;
  /** Calibration deciles: predicted-prob bin → [samples, realized rate]. */
  calibration: { bin: string; n: number; predicted: number; realized: number }[];
}

/** Brier + calibration of the raw model probability vs market mid. */
export function modelDiagnostics(scored: ScoredStep[]): ModelDiagnostics {
  let n = 0,
    bm = 0,
    bk = 0,
    nk = 0;
  const buckets = new Map<string, { n: number; bm: number; bk: number; nk: number }>();
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, oSum: 0 }));

  for (const s of scored) {
    const bucket = tauBucket(s.tauHours);
    const b = buckets.get(bucket) ?? { n: 0, bm: 0, bk: 0, nk: 0 };
    s.markets.forEach((m, i) => {
      const p = s.modelProbs[i];
      if (p === null) return;
      const o = m.result === "yes" ? 1 : 0;
      n++;
      bm += (p - o) ** 2;
      b.n++;
      b.bm += (p - o) ** 2;
      const mid = m.yesBid > 0 && m.yesAsk > 0 ? (m.yesBid + m.yesAsk) / 2 : null;
      if (mid !== null && mid > 0.005 && mid < 0.995) {
        bk += (mid - o) ** 2;
        nk++;
        b.bk += (mid - o) ** 2;
        b.nk++;
      }
      const bin = Math.min(9, Math.floor(p * 10));
      bins[bin].n++;
      bins[bin].pSum += p;
      bins[bin].oSum += o;
    });
    buckets.set(bucket, b);
  }

  return {
    n,
    brierModel: n > 0 ? bm / n : NaN,
    brierMarket: nk > 0 ? bk / nk : NaN,
    byBucket: Object.fromEntries(
      [...buckets.entries()].map(([k, v]) => [
        k,
        {
          n: v.n,
          brierModel: v.n > 0 ? v.bm / v.n : NaN,
          brierMarket: v.nk > 0 ? v.bk / v.nk : NaN,
        },
      ]),
    ),
    calibration: bins.map((bin, i) => ({
      bin: `${i * 10}-${i * 10 + 10}%`,
      n: bin.n,
      predicted: bin.n > 0 ? bin.pSum / bin.n : NaN,
      realized: bin.n > 0 ? bin.oSum / bin.n : NaN,
    })),
  };
}

// --- Trading simulation --------------------------------------------------------

export interface TradeParams {
  minEv: number; // dollars per contract
  minWinProb: number;
  minPriceCents: number;
  maxProbGap: number;
  maxTauHours: number;
  minTauMinutes: number;
  maxSpreadCents: number;
  minVolume: number;
  spotBackedMaxTauMin: number;
  spotBackedMinZ: number;
  /** Extra cents lost to adverse IOC fills. */
  adverseFillCents: number;
  /** Fixed stake per trade, cents. */
  stakeCents: number;
  /** TP/SL like the weather bot; null = hold every position to settlement. */
  exits: { takeProfitPct: number; stopLossPct: number } | null;
}

export interface SimTrade {
  eventTicker: string;
  asset: string;
  ticker: string;
  side: "yes" | "no";
  entryTs: number;
  tauHoursAtEntry: number;
  entryCents: number;
  feeCents: number;
  count: number;
  predWinProb: number;
  predEvCents: number;
  exit: "settle" | "take_profit" | "stop_loss";
  won: boolean | null; // null for pre-settlement exits
  pnlCents: number;
}

export interface SimSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlCents: number;
  feesCents: number;
  stakedCents: number;
  /** Return on total staked capital. */
  roi: number;
  avgPredEvCents: number;
  avgRealizedEvCents: number;
  maxDrawdownCents: number;
  byBucket: Record<string, { trades: number; pnlCents: number }>;
}

/**
 * Replay the buy filters + position lifecycle over scored steps.
 * One position per event (ladder strikes are perfectly correlated).
 */
export function simulateTrading(
  dataset: BtDataset,
  scored: ScoredStep[],
  p: TradeParams,
): { trades: SimTrade[]; summary: SimSummary } {
  const zProb = normalCdf(p.spotBackedMinZ, 0, 1);
  const byEvent = new Map<number, ScoredStep[]>();
  for (const s of scored) {
    const list = byEvent.get(s.eventIdx) ?? [];
    list.push(s);
    byEvent.set(s.eventIdx, list);
  }

  const trades: SimTrade[] = [];

  for (const [eventIdx, steps] of byEvent) {
    const event: BtEvent = dataset.events[eventIdx];
    steps.sort((a, b) => a.ts - b.ts);

    let pos: SimTrade | null = null;
    let closed = false;

    for (const s of steps) {
      // --- Exit management ---
      if (pos && !closed && p.exits) {
        const idx = s.markets.findIndex((m) => m.ticker === pos!.ticker);
        if (idx >= 0) {
          const m = s.markets[idx];
          const bid =
            pos.side === "yes"
              ? m.yesBid
              : m.yesAsk > 0
                ? 1 - m.yesAsk
                : 0;
          const bidC = Math.round(bid * 100);
          if (bidC >= 1) {
            const gain = bidC - pos.entryCents;
            const tp = gain / pos.entryCents >= p.exits.takeProfitPct / 100;
            const sl =
              (pos.entryCents - bidC) / pos.entryCents >= p.exits.stopLossPct / 100;
            if (tp || sl) {
              const sellFee = Math.round(kalshiFeePerContract(bidC / 100) * 100);
              pos.exit = tp ? "take_profit" : "stop_loss";
              pos.pnlCents =
                pos.count * (bidC - pos.entryCents - pos.feeCents - sellFee);
              pos.won = null;
              trades.push(pos);
              closed = true;
            }
          }
        }
      }
      if (pos) continue; // one position per event, no re-entry

      // --- Entry ---
      const tauMin = s.tauHours * 60;
      if (s.tauHours > p.maxTauHours || tauMin < p.minTauMinutes) continue;

      let best: SimTrade | null = null;
      let bestScore = -Infinity;

      for (let i = 0; i < s.markets.length; i++) {
        const m = s.markets[i];
        const modelProb = s.modelProbs[i];
        if (modelProb === null) continue;
        if (m.cumVol < p.minVolume) continue;

        const mid =
          m.yesBid > 0 && m.yesAsk > 0 && m.yesAsk < 1
            ? (m.yesBid + m.yesAsk) / 2
            : null;
        const marketProb = mid !== null && mid > 0.005 && mid < 0.995 ? mid : null;
        const obsBacked =
          tauMin <= p.spotBackedMaxTauMin &&
          (modelProb >= zProb || modelProb <= 1 - zProb);

        for (const side of ["yes", "no"] as const) {
          const askRaw = side === "yes" ? m.yesAsk : m.yesBid > 0 ? 1 - m.yesBid : 0;
          const bidRaw = side === "yes" ? m.yesBid : m.yesAsk > 0 ? 1 - m.yesAsk : 0;
          if (askRaw <= 0.005 || askRaw >= 0.995) continue;
          const askC = Math.round(askRaw * 100) + p.adverseFillCents;
          const bidC = Math.round(bidRaw * 100);
          if (askC < p.minPriceCents || askC > 99) continue;
          if (askC - bidC > p.maxSpreadCents) continue;

          const { pBlend } = blendProbability(
            modelProb,
            marketProb,
            m.cumVol,
            false,
            obsBacked,
          );
          const winProb = side === "yes" ? pBlend : 1 - pBlend;
          if (winProb < p.minWinProb) continue;

          if (marketProb !== null) {
            const sideMarketProb = side === "yes" ? marketProb : 1 - marketProb;
            if (winProb - sideMarketProb > p.maxProbGap) continue;
          }

          const fee = kalshiFeePerContract(askC / 100);
          const feeC = Math.round(fee * 100);
          const ev = winProb - askC / 100 - fee;
          if (ev < p.minEv) continue;

          const score = ev * Math.sqrt(winProb);
          if (score > bestScore) {
            const n = Math.floor(p.stakeCents / (askC + feeC));
            if (n < 1) continue;
            bestScore = score;
            best = {
              eventTicker: event.eventTicker,
              asset: event.asset,
              ticker: m.ticker,
              side,
              entryTs: s.ts,
              tauHoursAtEntry: s.tauHours,
              entryCents: askC,
              feeCents: feeC,
              count: n,
              predWinProb: winProb,
              predEvCents: Math.round(ev * 100),
              exit: "settle",
              won: null,
              pnlCents: 0,
            };
          }
        }
      }

      if (best) pos = best;
    }

    // Settle any still-open position
    if (pos && !closed) {
      const market = event.markets.find((m) => m.ticker === pos!.ticker);
      const won = market ? market.result === pos.side : false;
      pos.won = won;
      pos.pnlCents = won
        ? pos.count * (100 - pos.entryCents - pos.feeCents)
        : -pos.count * (pos.entryCents + pos.feeCents);
      trades.push(pos);
    }
  }

  return { trades, summary: summarize(trades) };
}

export function summarize(trades: SimTrade[]): SimSummary {
  let pnl = 0,
    fees = 0,
    staked = 0,
    wins = 0,
    losses = 0,
    predEv = 0,
    realEv = 0;
  const byBucket: Record<string, { trades: number; pnlCents: number }> = {};

  const ordered = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  let equity = 0,
    peak = 0,
    maxDD = 0;

  for (const t of ordered) {
    pnl += t.pnlCents;
    fees += t.count * t.feeCents;
    staked += t.count * (t.entryCents + t.feeCents);
    if (t.pnlCents > 0) wins++;
    else if (t.pnlCents < 0) losses++;
    predEv += t.predEvCents;
    realEv += t.pnlCents / t.count;
    equity += t.pnlCents;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);

    const bucket: TauBucket = tauBucket(t.tauHoursAtEntry);
    byBucket[bucket] = byBucket[bucket] ?? { trades: 0, pnlCents: 0 };
    byBucket[bucket].trades++;
    byBucket[bucket].pnlCents += t.pnlCents;
  }

  const n = trades.length;
  return {
    trades: n,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    pnlCents: pnl,
    feesCents: fees,
    stakedCents: staked,
    roi: staked > 0 ? pnl / staked : 0,
    avgPredEvCents: n > 0 ? predEv / n : 0,
    avgRealizedEvCents: n > 0 ? realEv / n : 0,
    maxDrawdownCents: maxDD,
    byBucket,
  };
}
