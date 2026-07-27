import { blendProbability, kalshiFeePerContract } from "@/lib/suggest";
import { evaluateExit } from "@/lib/tradeCommon";

/**
 * Pure replay engine for the weather backtest.
 *
 * Re-scores the app's recorded suggestion history under parameterized blend
 * weights and executor filters, then simulates the position lifecycle
 * (entry at the recorded ask + adverse-fill buffer, optional TP/SL exits
 * walked over the hourly snapshot price path, settlement from the recorded
 * result). Imports the PRODUCTION blend/fee/exit code so the sim exercises
 * exactly what will run live — including the decided-vs-market sanity guard.
 *
 * Approximations (documented in the report):
 *  - Fills at recorded ask + adverseFillCents (live IOC bids ask+5 max).
 *  - Exit bids ≈ side-probability × 100 − spreadHaircutCents (snapshots store
 *    a mid/last-price implied probability, not the true book).
 *  - No budget / max-open-positions modeling: fixed stake, one position per
 *    market, one per event ladder (matches the crypto backtest's approach).
 *  - Candidate pool = stored suggestions, which were generated at the old
 *    w=0.65 weights (EV ≥ 5¢ or consensus). Re-scoring only shrinks EV, so
 *    grids that tighten thresholds are safe; a minEv below 5¢ slightly
 *    under-samples the low-edge band (rows the old scorer never persisted).
 */

// --- Dataset shapes (written by fetch-weather.ts) ---------------------------

/**
 * Bump when WxRow gains fields the replay depends on — the CLI re-fetches
 * when the on-disk dataset's version is older, so a stale dataset can't
 * silently fail-close new gates (localHour: null would kill every
 * hour-gated combo invisibly).
 */
export const WX_DATASET_VERSION = 2;

export interface WxRow {
  id: number;
  ticker: string;
  event: string;
  side: "yes" | "no";
  kind: string;
  source: string;
  price: number; // suggested side's ask, dollars
  pModel: number; // raw model P(YES)
  pBlendStored: number;
  winProbStored: number;
  pMarket: number | null; // market-implied P(YES)
  fee: number; // dollars per contract at entry
  vol24: number | null;
  city: string | null;
  metric: string | null;
  lead: number | null;
  targetDate: string | null;
  /** Hour 0-23 at the settlement city when the suggestion was created; null when city unknown. */
  localHour: number | null;
  ts: number; // suggestion created_at, epoch ms
  result: "yes" | "no";
  exclude?: string | null; // bug-cohort marker
  decided?: boolean | null; // persisted provenance (new rows only)
  obsBacked?: boolean | null;
  blendW?: number | null;
}

export interface WxSnapPoint {
  ts: number;
  mp: number; // market-implied P(YES) at ts
}

export interface WxFinal {
  ticker: string;
  pModel: number;
  pMarket: number;
  lead: number | null;
  y: 0 | 1;
  exclude?: string | null;
}

export interface WxDataset {
  version?: number; // WX_DATASET_VERSION at fetch time; absent = v1
  fetchedAt: string;
  rows: WxRow[];
  snaps: Record<string, WxSnapPoint[]>;
  finals: WxFinal[];
}

// --- Parameters --------------------------------------------------------------

export interface WxModelParams {
  w: number; // base blend model weight
  wObs: number; // obs-backed blend model weight
}

export type LeadMode = "lead1" | "lead01" | "any";

/** Which metrics a config may trade (mirrors the live `metrics` allowlist). */
export type MetricMode = "all" | "high_only" | "high_low";

export interface WxExitParams {
  takeProfitMode: "profit_pct" | "capture_pct";
  takeProfitValue: number; // percent
  stopLossEnabled: boolean;
  stopLossPct: number; // percent
}

export interface WxTradeParams {
  minEv: number; // dollars
  minWinProb: number;
  minScore: number;
  minPriceCents: number;
  maxPriceCents: number; // 99 = no cap
  maxProbGap: number;
  leadMode: LeadMode;
  metricMode: MetricMode;
  obsBackedOnly: boolean;
  /**
   * Same-day (lead-0) rows may only enter at/after this local hour at the
   * settlement city; 0 disables. Lead-1+ rows always pass; unknown localHour
   * fails closed. Morning same-day highs were the bleed: the obsBacked flag
   * fires on the first station ob, hours before the daily max is set.
   */
  minLocalHourLead0: number;
  excludeCities: string[];
  exits: WxExitParams | null; // null = hold to settlement
  adverseFillCents: number;
  spreadHaircutCents: number;
  stakeCents: number;
  includeBugCohort?: boolean; // default false
}

export function metricAllowed(mode: MetricMode, metric: string | null): boolean {
  if (mode === "all") return true;
  if (mode === "high_only") return metric === "temperature_high";
  return metric === "temperature_high" || metric === "temperature_low";
}

// --- Blend-flag inference -----------------------------------------------------

const BASE_W = 0.65; // weight historical rows were generated with
const HIGH_VOLUME = 2000;
const HIGH_VOLUME_FACTOR = 0.8;

/**
 * Historical rows predate the persisted decided/obs_backed columns, so infer
 * which blend path produced them by comparing the implied applied weight
 * against what the normal vs obs-backed path would have produced.
 */
export function inferFlags(row: WxRow): { decided: boolean; obsBacked: boolean } {
  if (typeof row.decided === "boolean" || typeof row.obsBacked === "boolean") {
    return { decided: row.decided === true, obsBacked: row.obsBacked === true };
  }
  if (row.pMarket == null) return { decided: false, obsBacked: false };
  const denom = row.pModel - row.pMarket;
  if (Math.abs(denom) < 0.02) return { decided: false, obsBacked: false }; // path indistinguishable & irrelevant
  const impliedW = (row.pBlendStored - row.pMarket) / denom;
  if (impliedW >= 0.95) return { decided: true, obsBacked: false };

  const volFactor = (row.vol24 ?? 0) >= HIGH_VOLUME ? HIGH_VOLUME_FACTOR : 1;
  const extremity = Math.min(row.pMarket, 1 - row.pMarket);
  const tailFactor = Math.min(1, Math.max(0.25, extremity / 0.1));
  const d = Math.abs(denom);
  const disagreeFactor = d <= 0.25 ? 1 : Math.max(0.5, 1 - ((d - 0.25) / 0.25) * 0.5);
  const normalW = BASE_W * tailFactor * disagreeFactor * volFactor;
  const obsW = BASE_W * volFactor;
  const obsBacked =
    Math.abs(impliedW - obsW) < Math.abs(impliedW - normalW) && tailFactor * disagreeFactor < 0.999;
  return { decided: false, obsBacked };
}

// --- Re-scoring ----------------------------------------------------------------

export interface RescoredRow {
  winProb: number;
  ev: number; // dollars, fee-adjusted at recorded ask
  score: number;
  probGap: number; // winProb − side market prob
  appliedW: number;
}

export function rescoreRow(row: WxRow, model: WxModelParams): RescoredRow | null {
  if (row.pMarket == null) return null; // pre-clamp blend-hole rows: not re-scorable
  const flags = inferFlags(row);
  const { pBlend, w } = blendProbability(
    row.pModel,
    row.pMarket,
    row.vol24 ?? 0,
    flags.decided,
    flags.obsBacked,
    { model: model.w, obs: model.wObs },
  );
  const winProb = row.side === "yes" ? pBlend : 1 - pBlend;
  const ev = winProb - row.price - row.fee;
  const sideMarket = row.side === "yes" ? row.pMarket : 1 - row.pMarket;
  return {
    winProb,
    ev,
    score: ev * Math.sqrt(Math.max(0, winProb)),
    probGap: winProb - sideMarket,
    appliedW: w,
  };
}

// --- Stage-1 diagnostics ---------------------------------------------------------

export function blendBrierSweep(
  finals: WxFinal[],
  weights: number[],
): { w: number; brier: number; n: number }[] {
  const usable = finals.filter((f) => !f.exclude);
  return weights.map((w) => {
    let sum = 0;
    for (const f of usable) {
      const p = w * f.pModel + (1 - w) * f.pMarket;
      sum += (p - f.y) ** 2;
    }
    return { w, brier: sum / Math.max(1, usable.length), n: usable.length };
  });
}

export function reliabilityByLead(
  finals: WxFinal[],
  w: number,
): Record<string, { bucket: number; n: number; predicted: number; observed: number }[]> {
  const out: Record<string, { sum: number; hits: number; n: number }[]> = {};
  for (const f of finals) {
    if (f.exclude) continue;
    const lead = f.lead != null && f.lead <= 0 ? "0" : f.lead === 1 ? "1" : "2+";
    const p = w * f.pModel + (1 - w) * f.pMarket;
    const bins = (out[lead] ??= Array.from({ length: 10 }, () => ({ sum: 0, hits: 0, n: 0 })));
    const b = Math.min(9, Math.floor(p * 10));
    bins[b].sum += p;
    bins[b].hits += f.y;
    bins[b].n++;
  }
  const res: Record<string, { bucket: number; n: number; predicted: number; observed: number }[]> = {};
  for (const [lead, bins] of Object.entries(out)) {
    res[lead] = bins
      .map((b, i) => ({
        bucket: i,
        n: b.n,
        predicted: b.n ? b.sum / b.n : 0,
        observed: b.n ? b.hits / b.n : 0,
      }))
      .filter((b) => b.n > 0);
  }
  return res;
}

// --- Cohort reliability + empirical calibration -----------------------------------

/**
 * Suggestions are re-generated hourly, so raw rows are heavily autocorrelated
 * (one market contributes dozens of near-identical rows). Reliability and
 * λ fitting use the FIRST suggestion per ticker+side — one row per actual bet
 * opportunity, sampled at entry time. (v4 sampled the LAST suggestion, which
 * measured the model at its easiest late/obs-converged moment and flattered
 * both the cohort tables and the fitted λ.)
 */
export function dedupeFirstPerTicker(rows: WxRow[]): WxRow[] {
  const first = new Map<string, WxRow>();
  for (const r of rows) {
    const key = `${r.ticker}|${r.side}`;
    const prev = first.get(key);
    if (!prev || r.ts < prev.ts) first.set(key, r);
  }
  return [...first.values()];
}

function leadBucket(lead: number | null): string {
  if (lead != null && lead <= 0) return "0";
  if (lead === 1) return "1";
  return "2+";
}

function priceBand(price: number): string {
  const c = Math.round(price * 100);
  if (c < 40) return "<40";
  if (c <= 50) return "40-50";
  if (c <= 59) return "51-59";
  if (c <= 70) return "60-70";
  if (c <= 79) return "71-79";
  if (c <= 88) return "80-88";
  return "89+";
}

function metricGroup(metric: string | null): string {
  if (metric === "temperature_high") return "high";
  if (metric === "temperature_low") return "low";
  return metric ?? "?";
}

export interface CohortCell {
  cohort: string; // "high | 60-70 | lead 0 | obs"
  n: number;
  avgPredWinProb: number;
  realizedWinRate: number;
  gap: number; // avgPredWinProb − realizedWinRate (positive = overconfident)
  avgRealizedEvCents: number;
}

/**
 * The predicted-vs-realized win-prob table that makes miscalibration visible
 * per cohort — the live bot's ~5pp overconfidence hid inside aggregate P&L
 * for weeks. Computed on deduped rows.
 */
export function cohortReliability(
  rows: WxRow[],
  rescore: (row: WxRow) => RescoredRow | null,
): CohortCell[] {
  const acc = new Map<string, { n: number; pred: number; wins: number; evCents: number }>();
  for (const row of dedupeFirstPerTicker(rows)) {
    const r = rescore(row);
    if (!r) continue;
    const flags = inferFlags(row);
    const key = `${metricGroup(row.metric)} | ${priceBand(row.price)} | lead ${leadBucket(row.lead)} | ${flags.obsBacked ? "obs" : "fcst"}`;
    const cell = acc.get(key) ?? { n: 0, pred: 0, wins: 0, evCents: 0 };
    const won = row.side === row.result;
    cell.n++;
    cell.pred += r.winProb;
    cell.wins += won ? 1 : 0;
    cell.evCents += (won ? 100 : 0) - row.price * 100 - row.fee * 100;
    acc.set(key, cell);
  }
  return [...acc.entries()]
    .map(([cohort, c]) => ({
      cohort,
      n: c.n,
      avgPredWinProb: c.pred / c.n,
      realizedWinRate: c.wins / c.n,
      gap: c.pred / c.n - c.wins / c.n,
      avgRealizedEvCents: c.evCents / c.n,
    }))
    .sort((a, b) => b.n - a.n);
}

// λ shrink: p' = pMarketSide + λ·(winProb − pMarketSide). λ=0 trusts the
// market outright, λ=1 keeps the blend as-is. Fitted per cohort because the
// edge (if any) is cohort-specific — station obs leading the book on a
// same-day high is a different animal from a lead-1 overnight-low forecast.
const LAMBDA_GRID = [0, 0.25, 0.5, 0.75, 1];
const LAMBDA_MIN_COHORT_N = 150;

export interface LambdaTable {
  global: number;
  cohorts: Record<string, { lambda: number; n: number }>;
}

export function lambdaCohortKey(row: WxRow): string {
  const flags = inferFlags(row);
  return `${metricGroup(row.metric)}|${leadBucket(row.lead)}|${flags.obsBacked ? "obs" : "fcst"}`;
}

function bestLambda(
  samples: { winProb: number; sideMarket: number; won: boolean }[],
): number {
  let best = 1;
  let bestBrier = Infinity;
  for (const lambda of LAMBDA_GRID) {
    let sum = 0;
    for (const s of samples) {
      const p = Math.min(1, Math.max(0, s.sideMarket + lambda * (s.winProb - s.sideMarket)));
      sum += (p - (s.won ? 1 : 0)) ** 2;
    }
    const brier = sum / Math.max(1, samples.length);
    if (brier < bestBrier - 1e-12) {
      bestBrier = brier;
      best = lambda;
    }
  }
  return best;
}

/** Fit the per-cohort λ table on (deduped) training rows at fixed blend weights. */
export function fitLambdaTable(
  trainRows: WxRow[],
  rescore: (row: WxRow) => RescoredRow | null,
): LambdaTable {
  const byCohort = new Map<string, { winProb: number; sideMarket: number; won: boolean }[]>();
  const all: { winProb: number; sideMarket: number; won: boolean }[] = [];
  for (const row of dedupeFirstPerTicker(trainRows)) {
    const r = rescore(row);
    if (!r || row.pMarket == null) continue;
    const sideMarket = row.side === "yes" ? row.pMarket : 1 - row.pMarket;
    const sample = { winProb: r.winProb, sideMarket, won: row.side === row.result };
    all.push(sample);
    const key = lambdaCohortKey(row);
    (byCohort.get(key) ?? byCohort.set(key, []).get(key)!).push(sample);
  }
  const global = bestLambda(all);
  const cohorts: LambdaTable["cohorts"] = {};
  for (const [key, samples] of byCohort) {
    cohorts[key] =
      samples.length >= LAMBDA_MIN_COHORT_N
        ? { lambda: bestLambda(samples), n: samples.length }
        : { lambda: global, n: samples.length };
  }
  return { global, cohorts };
}

/** Wrap a rescore fn so winProb/ev/score reflect the fitted λ shrink. */
export function makeCalibratedRescore(
  rescore: (row: WxRow) => RescoredRow | null,
  table: LambdaTable,
): (row: WxRow) => RescoredRow | null {
  const cache = new Map<number, RescoredRow | null>();
  return (row: WxRow): RescoredRow | null => {
    if (cache.has(row.id)) return cache.get(row.id)!;
    let out: RescoredRow | null = null;
    const r = rescore(row);
    if (r && row.pMarket != null) {
      const sideMarket = row.side === "yes" ? row.pMarket : 1 - row.pMarket;
      const lambda = table.cohorts[lambdaCohortKey(row)]?.lambda ?? table.global;
      const winProb = Math.min(
        1,
        Math.max(0, sideMarket + lambda * (r.winProb - sideMarket)),
      );
      const ev = winProb - row.price - row.fee;
      out = {
        winProb,
        ev,
        score: ev * Math.sqrt(Math.max(0, winProb)),
        probGap: winProb - sideMarket,
        appliedW: r.appliedW,
      };
    }
    cache.set(row.id, out);
    return out;
  };
}

// --- Trading simulation -----------------------------------------------------------

export interface WxSimTrade {
  ticker: string;
  event: string;
  side: "yes" | "no";
  city: string | null;
  lead: number | null;
  entryTs: number;
  entryCents: number;
  feeCents: number;
  count: number;
  predWinProb: number;
  predEvCents: number;
  exitReason: "settled" | "take_profit" | "stop_loss";
  pnlCents: number; // total, net of all fees
}

export interface WxSimSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlCents: number;
  stakedCents: number;
  roi: number;
  avgPredEvCents: number;
  avgRealizedEvCents: number;
  maxDrawdownCents: number;
  byLead: Record<string, { trades: number; pnlCents: number }>;
  byExit: Record<string, { trades: number; pnlCents: number }>;
  byCity: Record<string, { trades: number; pnlCents: number }>;
}

export function simulateWeather(
  dataset: WxDataset,
  rows: WxRow[],
  rescore: (row: WxRow) => RescoredRow | null,
  p: WxTradeParams,
): { trades: WxSimTrade[]; summary: WxSimSummary } {
  const heldTickers = new Set<string>();
  const heldEvents = new Set<string>();
  const excludeCities = new Set(p.excludeCities);
  const trades: WxSimTrade[] = [];

  const ordered = [...rows].sort((a, b) => a.ts - b.ts);

  for (const row of ordered) {
    if (!p.includeBugCohort && row.exclude) continue;
    if (heldTickers.has(row.ticker) || heldEvents.has(row.event)) continue;
    if (row.city && excludeCities.has(row.city)) continue;
    if (p.leadMode === "lead1" && row.lead !== 1) continue;
    if (p.leadMode === "lead01" && row.lead !== 0 && row.lead !== 1) continue;
    // Afternoon gate: with one-position-per-ticker dedup below, the entry
    // becomes the FIRST suggestion at/after the gate hour — matching when
    // the live bot would actually buy.
    if (p.minLocalHourLead0 > 0 && row.lead != null && row.lead <= 0) {
      if (row.localHour == null || row.localHour < p.minLocalHourLead0) continue;
    }
    if (!metricAllowed(p.metricMode, row.metric)) continue;
    if (p.obsBackedOnly && !inferFlags(row).obsBacked) continue;

    const askCents = Math.round(row.price * 100);
    if (askCents < p.minPriceCents || askCents > Math.min(99, p.maxPriceCents)) continue;

    const r = rescore(row);
    if (!r) continue;
    if (r.ev < p.minEv || r.winProb < p.minWinProb || r.score < p.minScore) continue;
    if (r.probGap > p.maxProbGap) continue;

    const entryCents = Math.min(99, askCents + p.adverseFillCents);
    const feeCents = Math.round(kalshiFeePerContract(entryCents / 100) * 100);
    const count = Math.floor(p.stakeCents / (entryCents + feeCents));
    if (count < 1) continue;

    heldTickers.add(row.ticker);
    heldEvents.add(row.event);

    // --- Exit walk over the hourly snapshot price path ---
    let exitReason: WxSimTrade["exitReason"] = "settled";
    let pnlPerContract: number | null = null;
    if (p.exits) {
      const path = dataset.snaps[row.ticker] ?? [];
      for (const pt of path) {
        if (pt.ts <= row.ts) continue;
        const sideProb = row.side === "yes" ? pt.mp : 1 - pt.mp;
        const bid = Math.max(1, Math.min(99, Math.round(sideProb * 100) - p.spreadHaircutCents));
        const reason = evaluateExit(entryCents, bid, {
          takeProfitMode: p.exits.takeProfitMode,
          takeProfitValue: p.exits.takeProfitValue,
          stopLossEnabled: p.exits.stopLossEnabled,
          stopLossPct: p.exits.stopLossPct,
        });
        if (reason) {
          const sellFee = Math.round(kalshiFeePerContract(bid / 100) * 100);
          pnlPerContract = bid - entryCents - feeCents - sellFee;
          exitReason = reason;
          break;
        }
      }
    }
    if (pnlPerContract === null) {
      const won = row.side === row.result;
      pnlPerContract = won ? 100 - entryCents - feeCents : -(entryCents + feeCents);
      exitReason = "settled";
    }

    trades.push({
      ticker: row.ticker,
      event: row.event,
      side: row.side,
      city: row.city,
      lead: row.lead,
      entryTs: row.ts,
      entryCents,
      feeCents,
      count,
      predWinProb: r.winProb,
      predEvCents: Math.round(r.ev * 100),
      exitReason,
      pnlCents: pnlPerContract * count,
    });
  }

  return { trades, summary: summarizeWeather(trades) };
}

export function summarizeWeather(trades: WxSimTrade[]): WxSimSummary {
  let pnl = 0,
    staked = 0,
    wins = 0,
    losses = 0,
    predEv = 0,
    realEv = 0;
  const byLead: WxSimSummary["byLead"] = {};
  const byExit: WxSimSummary["byExit"] = {};
  const byCity: WxSimSummary["byCity"] = {};

  let equity = 0,
    peak = 0,
    maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.entryTs - b.entryTs)) {
    pnl += t.pnlCents;
    staked += t.count * (t.entryCents + t.feeCents);
    if (t.pnlCents > 0) wins++;
    else if (t.pnlCents < 0) losses++;
    predEv += t.predEvCents;
    realEv += t.pnlCents / t.count;
    equity += t.pnlCents;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);

    const lead = t.lead == null ? "?" : String(t.lead);
    (byLead[lead] ??= { trades: 0, pnlCents: 0 }).trades++;
    byLead[lead].pnlCents += t.pnlCents;
    (byExit[t.exitReason] ??= { trades: 0, pnlCents: 0 }).trades++;
    byExit[t.exitReason].pnlCents += t.pnlCents;
    const city = t.city ?? "?";
    (byCity[city] ??= { trades: 0, pnlCents: 0 }).trades++;
    byCity[city].pnlCents += t.pnlCents;
  }

  const n = trades.length;
  return {
    trades: n,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    pnlCents: pnl,
    stakedCents: staked,
    roi: staked > 0 ? pnl / staked : 0,
    avgPredEvCents: n ? predEv / n : 0,
    avgRealizedEvCents: n ? realEv / n : 0,
    maxDrawdownCents: maxDD,
    byLead,
    byExit,
    byCity,
  };
}
