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
  maxProbGap: number;
  leadMode: LeadMode;
  excludeCities: string[];
  exits: WxExitParams | null; // null = hold to settlement
  adverseFillCents: number;
  spreadHaircutCents: number;
  stakeCents: number;
  includeBugCohort?: boolean; // default false
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

    const askCents = Math.round(row.price * 100);
    if (askCents < p.minPriceCents || askCents > 99) continue;

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
