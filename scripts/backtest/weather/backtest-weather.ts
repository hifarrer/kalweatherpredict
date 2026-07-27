import "./load-env"; // MUST be first: db client reads DATABASE_URL at import time
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchWeatherDataset, loadWeatherDataset } from "./fetch-weather";
import {
  blendBrierSweep,
  CohortCell,
  cohortReliability,
  fitLambdaTable,
  LambdaTable,
  LeadMode,
  makeCalibratedRescore,
  MetricMode,
  reliabilityByLead,
  RescoredRow,
  rescoreRow,
  simulateWeather,
  WX_DATASET_VERSION,
  WxDataset,
  WxExitParams,
  WxModelParams,
  WxRow,
  WxSimSummary,
  WxSimTrade,
  WxTradeParams,
} from "./replay-weather";

/**
 * Weather strategy backtest CLI (mirrors scripts/backtest/backtest-crypto.ts).
 *
 *   npm run backtest:weather:fetch    # pull graded history into backtest-data/weather/
 *   npm run backtest:weather:run      # grid-search, write results.json
 *   npm run backtest:weather:report   # render docs/weather-backtest-report.md
 *   npm run backtest:weather:apply    # patch the LIVE automation settings to the chosen config
 *
 * Methodology (v2, 2026-07-24): walk-forward with three expanding-origin
 * folds. A combo survives only if train AND validation P&L are positive in
 * EVERY fold; survivors are ranked by pooled validation P&L, must clear a
 * hold-to-settle floor (settlement edge without path-dependent TP luck), and
 * ties within 90% of the best go to the config with the fewest active
 * restrictions. A per-cohort λ-shrink calibration stage then tries to beat
 * the best uncalibrated config under the same rules.
 *
 * The previous single-70/30-split methodology chose a config that validated
 * +$93 and lost money live in 8 days — its profit was entirely take-profit
 * path exits (+$272 TP / −$179 settled). The hold floor exists so that can't
 * happen again. Bug-cohort rows (pre-fix midnight-rollover, Weather-Company-
 * settled series) stay excluded so we don't tune around fixed defects.
 */

const DATA_DIR = join("backtest-data", "weather");
const RESULTS_PATH = join(DATA_DIR, "results.json");
const REPORT_PATH = join("docs", "weather-backtest-report.md");

// --- Grids -------------------------------------------------------------------

const MODEL_GRID: WxModelParams[] = [];
for (const w of [0, 0.05, 0.1, 0.2]) {
  for (const wObs of [0.2, 0.35, 0.5]) MODEL_GRID.push({ w, wObs });
}

const EXIT_GRID: { key: string; exits: WxExitParams | null }[] = [
  { key: "hold", exits: null },
  { key: "tp30", exits: { takeProfitMode: "profit_pct", takeProfitValue: 30, stopLossEnabled: false, stopLossPct: 50 } },
  // capture_pct exits stay reachable at high entry cost — profit_pct 50 is
  // mathematically unreachable above 67¢, which silently turned the old
  // config's expensive entries into hold-to-settlement losers.
  { key: "cap30", exits: { takeProfitMode: "capture_pct", takeProfitValue: 30, stopLossEnabled: false, stopLossPct: 50 } },
  { key: "cap50", exits: { takeProfitMode: "capture_pct", takeProfitValue: 50, stopLossEnabled: false, stopLossPct: 50 } },
  { key: "cap30sl30", exits: { takeProfitMode: "capture_pct", takeProfitValue: 30, stopLossEnabled: true, stopLossPct: 30 } },
];

const EXCLUDE_CITIES = ["LAS", "DAL", "MSY"];

interface TradeGridPoint {
  minEv: number;
  minPriceCents: number;
  maxPriceCents: number;
  maxProbGap: number;
  leadMode: LeadMode;
  metricMode: MetricMode;
  obsBackedOnly: boolean;
  minLocalHourLead0: number;
  exitKey: string;
}

// v4.1 prunes vs v4: maxPriceCents 85 and maxProbGap 0.1 never differentiated
// survivors; metricMode "all" duplicates high_low now that rain is hard-
// excluded live. The freed budget funds the afternoon-gate dimension.
function tradeGrid(): TradeGridPoint[] {
  const out: TradeGridPoint[] = [];
  for (const minEv of [0.08, 0.12, 0.15])
    for (const minPriceCents of [40, 50, 60, 70, 80])
      for (const leadMode of ["lead1", "lead01"] as LeadMode[])
        for (const metricMode of ["high_only", "high_low"] as MetricMode[])
          for (const obsBackedOnly of [false, true]) {
            // obs-backed picks are same-day by construction — lead1 would
            // be the empty set
            if (obsBackedOnly && leadMode === "lead1") continue;
            for (const minLocalHourLead0 of [0, 13, 15, 17]) {
              // The hour gate only touches lead-0 rows; under lead1 every
              // hour value is the identical combo — sweep it once.
              if (leadMode === "lead1" && minLocalHourLead0 !== 0) continue;
              for (const { key } of EXIT_GRID) {
                out.push({
                  minEv,
                  minPriceCents,
                  maxPriceCents: 99,
                  maxProbGap: 0.2,
                  leadMode,
                  metricMode,
                  obsBackedOnly,
                  minLocalHourLead0,
                  exitKey: key,
                });
              }
            }
          }
  return out;
}

const FIXED: Pick<
  WxTradeParams,
  "minScore" | "minWinProb" | "adverseFillCents" | "spreadHaircutCents" | "stakeCents"
> = {
  minScore: 0.05,
  minWinProb: 0.3, // 0.4/0.5 tied ranks 1-3 last run — not a real dimension
  adverseFillCents: 1,
  spreadHaircutCents: 3,
  stakeCents: 1000,
};

/** How many "active restrictions" a config carries (simplicity tie-break). */
function restrictionCount(g: TradeGridPoint): number {
  let n = 0;
  if (g.obsBackedOnly) n++;
  if (g.metricMode !== "all") n++;
  if (g.maxPriceCents < 99) n++;
  if (g.leadMode === "lead1") n++;
  if (g.minPriceCents > 40) n++;
  if (g.minEv > 0.08) n++;
  if (g.minLocalHourLead0 > 0) n++;
  return n;
}

// --- Run ----------------------------------------------------------------------

const FOLD_COUNT = 3;
const MIN_TRAIN_TRADES = 30;
const MIN_VAL_TRADES_PER_FOLD = 8;
const MIN_POOLED_VAL_TRADES = 30;
const HOLD_FLOOR_TOP_N = 500;
const LAMBDA_TOP_N = 200;
const TIE_BREAK_BAND = 0.9; // within 90% of best pooled val P&L
const ACCEPT_MIN_REALIZED_EV_CENTS = 2;
const ACCEPT_MAX_HOLD_GAP_PP = 3;

interface Fold {
  train: WxRow[];
  val: WxRow[];
  trainRange: [string, string];
  valRange: [string, string];
}

interface PooledVal {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlCents: number;
  stakedCents: number;
  roi: number;
  avgPredEvCents: number;
  avgRealizedEvCents: number;
  byExit: Record<string, { trades: number; pnlCents: number }>;
  minFoldTrades: number;
  minFoldPnlCents: number;
}

interface FoldOutcome {
  train: WxSimSummary;
  val: WxSimSummary;
}

interface ComboResult {
  model: WxModelParams;
  trade: TradeGridPoint;
  restrictions: number;
  calibrated: boolean;
  folds: FoldOutcome[];
  pooledVal: PooledVal;
  /** Same filters, exits=null, validation folds only. Filled for top combos. */
  holdPooledPnlCents?: number;
  /** avg predicted winProb − settlement win rate on the hold variant, in pp. */
  holdGapPP?: number;
}

interface AcceptanceCheck {
  criterion: string;
  pass: boolean;
  detail: string;
}

interface Results {
  ranAt: string;
  datasetFetchedAt: string;
  totalRows: number;
  usableRows: number;
  excludedByReason: Record<string, number>;
  folds: { trainRange: [string, string]; valRange: [string, string]; trainRows: number; valRows: number }[];
  stage1: { w: number; brier: number; n: number }[];
  reliability: ReturnType<typeof reliabilityByLead>;
  combosTested: number;
  survivors: number;
  calibratedSurvivors: number;
  top: ComboResult[];
  chosen: ComboResult | null;
  acceptance: AcceptanceCheck[];
  accepted: boolean;
  cohortTable: CohortCell[];
  /** Per-fold λ tables for the chosen calibrated config (empty when uncalibrated). */
  chosenLambdaTables: LambdaTable[];
  /** λ table fitted on ALL usable rows — the values to port to production. */
  productionLambda: LambdaTable | null;
}

function rowDate(r: WxRow): string {
  return r.targetDate ?? new Date(r.ts).toISOString().slice(0, 10);
}

/**
 * Three expanding-origin folds over the last up-to-12 target dates: each
 * fold trains on everything before its validation window. Every fold's
 * validation is genuinely out-of-sample for the parameters judged on it.
 */
function buildFolds(usable: WxRow[]): Fold[] {
  const dates = [...new Set(usable.map(rowDate))].sort();
  const valTotal = Math.min(12, Math.max(FOLD_COUNT, Math.floor(dates.length / 2)));
  const valDates = dates.slice(-valTotal);
  const chunkSize = Math.ceil(valDates.length / FOLD_COUNT);
  const folds: Fold[] = [];
  for (let i = 0; i < FOLD_COUNT; i++) {
    const chunk = valDates.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) continue;
    const chunkSet = new Set(chunk);
    const train = usable.filter((r) => rowDate(r) < chunk[0]);
    const val = usable.filter((r) => chunkSet.has(rowDate(r)));
    if (train.length === 0 || val.length === 0) continue;
    folds.push({
      train,
      val,
      trainRange: [dates[0], chunk[0]],
      valRange: [chunk[0], chunk[chunk.length - 1]],
    });
  }
  return folds;
}

function poolVal(folds: FoldOutcome[]): PooledVal {
  let trades = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    staked = 0,
    predEv = 0,
    realEv = 0;
  const byExit: PooledVal["byExit"] = {};
  let minFoldTrades = Infinity;
  let minFoldPnl = Infinity;
  for (const f of folds) {
    const v = f.val;
    trades += v.trades;
    wins += v.wins;
    losses += v.losses;
    pnl += v.pnlCents;
    staked += v.stakedCents;
    predEv += v.avgPredEvCents * v.trades;
    realEv += v.avgRealizedEvCents * v.trades;
    minFoldTrades = Math.min(minFoldTrades, v.trades);
    minFoldPnl = Math.min(minFoldPnl, v.pnlCents);
    for (const [k, e] of Object.entries(v.byExit)) {
      (byExit[k] ??= { trades: 0, pnlCents: 0 }).trades += e.trades;
      byExit[k].pnlCents += e.pnlCents;
    }
  }
  return {
    trades,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    pnlCents: pnl,
    stakedCents: staked,
    roi: staked > 0 ? pnl / staked : 0,
    avgPredEvCents: trades ? predEv / trades : 0,
    avgRealizedEvCents: trades ? realEv / trades : 0,
    byExit,
    minFoldTrades: Number.isFinite(minFoldTrades) ? minFoldTrades : 0,
    minFoldPnlCents: Number.isFinite(minFoldPnl) ? minFoldPnl : 0,
  };
}

function tradeParams(g: TradeGridPoint, exits: WxExitParams | null): WxTradeParams {
  return {
    ...FIXED,
    minEv: g.minEv,
    minPriceCents: g.minPriceCents,
    maxPriceCents: g.maxPriceCents,
    maxProbGap: g.maxProbGap,
    leadMode: g.leadMode,
    metricMode: g.metricMode,
    obsBackedOnly: g.obsBackedOnly,
    minLocalHourLead0: g.minLocalHourLead0,
    excludeCities: EXCLUDE_CITIES,
    exits,
  };
}

type Rescore = (row: WxRow) => RescoredRow | null;

function makeCachedRescore(model: WxModelParams): Rescore {
  const cache = new Map<number, RescoredRow | null>();
  return (row) => {
    if (!cache.has(row.id)) cache.set(row.id, rescoreRow(row, model));
    return cache.get(row.id)!;
  };
}

/** Run a combo across all folds; null if it fails per-fold survival. */
function runCombo(
  dataset: WxDataset,
  folds: { train: WxRow[]; val: WxRow[] }[],
  rescore: Rescore,
  g: TradeGridPoint,
  model: WxModelParams,
  calibrated: boolean,
): ComboResult | null {
  const exits = EXIT_GRID.find((e) => e.key === g.exitKey)!.exits;
  const params = tradeParams(g, exits);
  const outcomes: FoldOutcome[] = [];
  for (const fold of folds) {
    const train = simulateWeather(dataset, fold.train, rescore, params).summary;
    if (train.trades < MIN_TRAIN_TRADES || train.pnlCents <= 0) return null;
    const val = simulateWeather(dataset, fold.val, rescore, params).summary;
    if (val.trades < MIN_VAL_TRADES_PER_FOLD || val.pnlCents <= 0) return null;
    outcomes.push({ train, val });
  }
  return {
    model,
    trade: g,
    restrictions: restrictionCount(g),
    calibrated,
    folds: outcomes,
    pooledVal: poolVal(outcomes),
  };
}

/** Hold-to-settle re-sim of a combo's validation folds: pooled P&L + prob gap. */
function holdFloor(
  dataset: WxDataset,
  folds: { val: WxRow[] }[],
  rescore: Rescore,
  g: TradeGridPoint,
): { pnlCents: number; gapPP: number } {
  const params = tradeParams(g, null);
  let pnl = 0;
  const all: WxSimTrade[] = [];
  for (const fold of folds) {
    const sim = simulateWeather(dataset, fold.val, rescore, params);
    pnl += sim.summary.pnlCents;
    all.push(...sim.trades);
  }
  const n = all.length;
  const avgPred = n ? all.reduce((s, t) => s + t.predWinProb, 0) / n : 0;
  const winRate = n ? all.filter((t) => t.pnlCents > 0).length / n : 0;
  return { pnlCents: pnl, gapPP: (avgPred - winRate) * 100 };
}

function evaluateAcceptance(c: ComboResult | null): AcceptanceCheck[] {
  if (!c) {
    return [
      { criterion: "any survivor", pass: false, detail: "no combo was profitable in every fold" },
    ];
  }
  const checks: AcceptanceCheck[] = [];
  checks.push({
    criterion: "validation P&L > 0 in all folds",
    pass: c.pooledVal.minFoldPnlCents > 0,
    detail: `worst fold ${(c.pooledVal.minFoldPnlCents / 100).toFixed(2)}$`,
  });
  checks.push({
    criterion: `≥${MIN_POOLED_VAL_TRADES} pooled / ≥${MIN_VAL_TRADES_PER_FOLD} per-fold validation trades`,
    pass:
      c.pooledVal.trades >= MIN_POOLED_VAL_TRADES &&
      c.pooledVal.minFoldTrades >= MIN_VAL_TRADES_PER_FOLD,
    detail: `${c.pooledVal.trades} pooled, min fold ${c.pooledVal.minFoldTrades}`,
  });
  checks.push({
    criterion: "hold-to-settle pooled validation P&L ≥ 0",
    pass: (c.holdPooledPnlCents ?? -1) >= 0,
    detail: `$${(((c.holdPooledPnlCents ?? 0)) / 100).toFixed(2)} without TP exits`,
  });
  checks.push({
    criterion: `pooled validation realized EV ≥ +${ACCEPT_MIN_REALIZED_EV_CENTS}¢/contract`,
    pass: c.pooledVal.avgRealizedEvCents >= ACCEPT_MIN_REALIZED_EV_CENTS,
    detail: `${c.pooledVal.avgRealizedEvCents.toFixed(1)}¢ realized (predicted ${c.pooledVal.avgPredEvCents.toFixed(1)}¢)`,
  });
  checks.push({
    criterion: `predicted-vs-realized winProb gap ≤ ${ACCEPT_MAX_HOLD_GAP_PP}pp (hold variant)`,
    pass: (c.holdGapPP ?? 100) <= ACCEPT_MAX_HOLD_GAP_PP,
    detail: `${(c.holdGapPP ?? 100).toFixed(1)}pp overconfidence`,
  });
  return checks;
}

function run(): void {
  const dataset = loadWeatherDataset();
  const usable = dataset.rows.filter((r) => !r.exclude && r.pMarket != null);
  const excludedByReason: Record<string, number> = {};
  for (const r of dataset.rows) {
    const reason = r.exclude ?? (r.pMarket == null ? "no_market_prob" : null);
    if (reason) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }

  const folds = buildFolds(usable);
  console.log(
    `[run] ${usable.length} usable rows (${dataset.rows.length} total), ${folds.length} walk-forward folds:`,
  );
  for (const f of folds) {
    console.log(
      `[run]   train ${f.trainRange[0]}..<${f.trainRange[1]} (${f.train.length}) → val ${f.valRange[0]}..${f.valRange[1]} (${f.val.length})`,
    );
  }

  // Stage 1 — raw blend sweep + reliability at the shipped weight
  const stage1 = blendBrierSweep(dataset.finals, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1]);
  const reliability = reliabilityByLead(dataset.finals, 0.2);

  // Stage 2 — walk-forward grid search
  const grid = tradeGrid();
  const results: ComboResult[] = [];
  let combosTested = 0;
  const rescoreByModel = new Map<WxModelParams, Rescore>();

  for (const model of MODEL_GRID) {
    const rescore = makeCachedRescore(model);
    rescoreByModel.set(model, rescore);
    // Pre-filter each fold to rows that can pass the loosest grid minima —
    // sims then only walk plausible candidates.
    const preFolds = folds.map((f) => ({
      train: f.train.filter((r) => {
        const s = rescore(r);
        return s && s.ev >= 0.08 && s.winProb >= FIXED.minWinProb;
      }),
      val: f.val.filter((r) => {
        const s = rescore(r);
        return s && s.ev >= 0.08 && s.winProb >= FIXED.minWinProb;
      }),
    }));
    for (const g of grid) {
      combosTested++;
      const combo = runCombo(dataset, preFolds, rescore, g, model, false);
      if (combo) results.push(combo);
    }
    console.log(`[run] model w=${model.w}/wObs=${model.wObs}: ${results.length} survivors so far`);
  }

  results.sort((a, b) => b.pooledVal.pnlCents - a.pooledVal.pnlCents);

  // Hold-to-settle floor for the top survivors: settlement edge must exist
  // without path-dependent take-profit luck.
  for (const c of results.slice(0, HOLD_FLOOR_TOP_N)) {
    const rescore = rescoreByModel.get(c.model)!;
    const hf = holdFloor(dataset, folds, rescore, c.trade);
    c.holdPooledPnlCents = hf.pnlCents;
    c.holdGapPP = hf.gapPP;
  }

  const eligible = results
    .slice(0, HOLD_FLOOR_TOP_N)
    .filter((c) => (c.holdPooledPnlCents ?? -1) >= 0);

  // Simplicity tie-break: among eligible combos within 90% of the best pooled
  // validation P&L, prefer the fewest active restrictions.
  const pickWithTieBreak = (pool: ComboResult[]): ComboResult | null => {
    if (pool.length === 0) return null;
    const best = pool[0].pooledVal.pnlCents;
    const band = pool.filter((c) => c.pooledVal.pnlCents >= best * TIE_BREAK_BAND);
    band.sort(
      (a, b) =>
        a.restrictions - b.restrictions || b.pooledVal.pnlCents - a.pooledVal.pnlCents,
    );
    return band[0];
  };
  let chosen = pickWithTieBreak(eligible);

  // Stage 2b — per-cohort λ calibration on the top survivors. λ tables are
  // fitted per fold on that fold's train only; a calibrated config replaces
  // the uncalibrated pick only if it beats it under the identical rules.
  let calibratedSurvivors = 0;
  let chosenLambdaTables: LambdaTable[] = [];
  const lambdaTables = new Map<WxModelParams, LambdaTable[]>();
  const calibratedRescores = new Map<WxModelParams, Rescore[]>();
  const calibratedResults: ComboResult[] = [];
  for (const c of results.slice(0, LAMBDA_TOP_N)) {
    const rescore = rescoreByModel.get(c.model)!;
    if (!lambdaTables.has(c.model)) {
      const tables = folds.map((f) => fitLambdaTable(f.train, rescore));
      lambdaTables.set(c.model, tables);
      calibratedRescores.set(
        c.model,
        tables.map((t) => makeCalibratedRescore(rescore, t)),
      );
    }
    const perFold = calibratedRescores.get(c.model)!;
    // Per-fold rescores differ (per-fold λ), so simulate fold-by-fold.
    const exits = EXIT_GRID.find((e) => e.key === c.trade.exitKey)!.exits;
    const params = tradeParams(c.trade, exits);
    const outcomes: FoldOutcome[] = [];
    let failed = false;
    for (let i = 0; i < folds.length; i++) {
      const train = simulateWeather(dataset, folds[i].train, perFold[i], params).summary;
      if (train.trades < MIN_TRAIN_TRADES || train.pnlCents <= 0) {
        failed = true;
        break;
      }
      const val = simulateWeather(dataset, folds[i].val, perFold[i], params).summary;
      if (val.trades < MIN_VAL_TRADES_PER_FOLD || val.pnlCents <= 0) {
        failed = true;
        break;
      }
      outcomes.push({ train, val });
    }
    if (failed) continue;
    calibratedSurvivors++;
    const combo: ComboResult = {
      model: c.model,
      trade: c.trade,
      restrictions: c.restrictions,
      calibrated: true,
      folds: outcomes,
      pooledVal: poolVal(outcomes),
    };
    // Hold floor under the same per-fold calibrated rescores
    let holdPnl = 0;
    const holdTrades: WxSimTrade[] = [];
    const holdParams = tradeParams(c.trade, null);
    for (let i = 0; i < folds.length; i++) {
      const sim = simulateWeather(dataset, folds[i].val, perFold[i], holdParams);
      holdPnl += sim.summary.pnlCents;
      holdTrades.push(...sim.trades);
    }
    combo.holdPooledPnlCents = holdPnl;
    const n = holdTrades.length;
    combo.holdGapPP = n
      ? (holdTrades.reduce((s, t) => s + t.predWinProb, 0) / n -
          holdTrades.filter((t) => t.pnlCents > 0).length / n) *
        100
      : 100;
    calibratedResults.push(combo);
  }
  calibratedResults.sort((a, b) => b.pooledVal.pnlCents - a.pooledVal.pnlCents);
  const calibratedEligible = calibratedResults.filter(
    (c) => (c.holdPooledPnlCents ?? -1) >= 0,
  );
  const bestCalibrated = pickWithTieBreak(calibratedEligible);
  if (
    bestCalibrated &&
    (!chosen || bestCalibrated.pooledVal.pnlCents > chosen.pooledVal.pnlCents)
  ) {
    chosen = bestCalibrated;
    chosenLambdaTables = lambdaTables.get(bestCalibrated.model)!;
  }

  const acceptance = evaluateAcceptance(chosen);
  const accepted = acceptance.every((a) => a.pass);

  // Cohort reliability table at the chosen (or default shipped) model params
  const cohortModel = chosen?.model ?? { w: 0.2, wObs: 0.5 };
  const cohortRescoreBase =
    rescoreByModel.get(cohortModel) ?? makeCachedRescore(cohortModel);
  const cohortTable = cohortReliability(usable, cohortRescoreBase);

  // λ table on ALL usable rows for the production port (only meaningful when
  // the chosen config is calibrated).
  const productionLambda = chosen?.calibrated
    ? fitLambdaTable(usable, rescoreByModel.get(chosen.model)!)
    : null;

  const out: Results = {
    ranAt: new Date().toISOString(),
    datasetFetchedAt: dataset.fetchedAt,
    totalRows: dataset.rows.length,
    usableRows: usable.length,
    excludedByReason,
    folds: folds.map((f) => ({
      trainRange: f.trainRange,
      valRange: f.valRange,
      trainRows: f.train.length,
      valRows: f.val.length,
    })),
    stage1,
    reliability,
    combosTested,
    survivors: results.length,
    calibratedSurvivors,
    top: [...results.slice(0, 15), ...(chosen && chosen.calibrated ? [chosen] : [])],
    chosen,
    acceptance,
    accepted,
    cohortTable,
    chosenLambdaTables,
    productionLambda,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 1));
  console.log(
    `[run] ${combosTested} combos tested, ${results.length} survivors (${calibratedSurvivors} calibrated) → ${RESULTS_PATH}`,
  );
  if (chosen) {
    console.log(
      `[run] chosen${chosen.calibrated ? " (λ-calibrated)" : ""}: w=${chosen.model.w}/${chosen.model.wObs} ${JSON.stringify(chosen.trade)}` +
        `\n[run] pooled val: ${fmtPooled(chosen.pooledVal)} | hold floor $${((chosen.holdPooledPnlCents ?? 0) / 100).toFixed(2)} | gap ${(chosen.holdGapPP ?? 0).toFixed(1)}pp`,
    );
    console.log(`[run] acceptance: ${accepted ? "PASSED" : "FAILED"}`);
    for (const a of acceptance) {
      console.log(`[run]   ${a.pass ? "✓" : "✗"} ${a.criterion} — ${a.detail}`);
    }
  } else {
    console.log(
      "[run] NO combo survived every fold + hold floor — do not apply; stay in micro-mode and collect more data.",
    );
  }
}

function fmtSummary(s: WxSimSummary): string {
  return `${s.trades} trades, ${(100 * s.winRate).toFixed(0)}% win, $${(s.pnlCents / 100).toFixed(2)} (ROI ${(100 * s.roi).toFixed(1)}%)`;
}

function fmtPooled(p: PooledVal): string {
  return `${p.trades} trades, ${(100 * p.winRate).toFixed(0)}% win, $${(p.pnlCents / 100).toFixed(2)} (ROI ${(100 * p.roi).toFixed(1)}%)`;
}

function fmtTrade(g: TradeGridPoint): string {
  return (
    `ev≥${g.minEv} px ${g.minPriceCents}-${g.maxPriceCents} gap≤${g.maxProbGap} ` +
    `${g.leadMode} ${g.metricMode}${g.obsBackedOnly ? " obs-only" : ""}` +
    `${g.minLocalHourLead0 > 0 ? ` h≥${g.minLocalHourLead0}` : ""}`
  );
}

// --- Report ---------------------------------------------------------------------

function report(): void {
  const res = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Results;
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# Weather strategy backtest`);
  push();
  push(`Generated ${res.ranAt} from dataset fetched ${res.datasetFetchedAt}.`);
  push();
  push(
    `Dataset: ${res.totalRows} graded weather suggestions; ${res.usableRows} usable after excluding ` +
      Object.entries(res.excludedByReason)
        .map(([k, v]) => `${k} (${v})`)
        .join(", ") +
      `.`,
  );
  push();
  push(`## Walk-forward folds (expanding origin)`);
  push();
  push(`| fold | train | validation |`);
  push(`| --- | --- | --- |`);
  res.folds.forEach((f, i) => {
    push(
      `| ${i + 1} | ${f.trainRange[0]} → <${f.trainRange[1]} (${f.trainRows} rows) | ${f.valRange[0]} → ${f.valRange[1]} (${f.valRows} rows) |`,
    );
  });
  push();
  push(`## Stage 1 — blend-weight Brier sweep (final snapshots, bug cohort excluded)`);
  push();
  push(`| model weight w | Brier |`);
  push(`| --- | --- |`);
  for (const s of res.stage1) push(`| ${s.w} | ${s.brier.toFixed(4)} |`);
  push();
  push(
    `**Read stage 1 with care:** final snapshots are captured minutes before close, when the book ` +
      `has already converged on the outcome — so this sweep flatters the market and would pick w≈0. ` +
      `Trading happens hours earlier; the stage-2 simulation (which scores at suggestion time, fee- and ` +
      `price-aware) is the authority on weights.`,
  );
  push();
  push(
    `## Stage 2 — walk-forward grid (${res.combosTested} combos, ${res.survivors} survived every fold, ${res.calibratedSurvivors} λ-calibrated survivors)`,
  );
  push();
  if (!res.chosen) {
    push(
      `**No combination survived every fold plus the hold-to-settle floor.** Do not apply anything: ` +
        `stay in micro-mode (or pause buys) and re-run after 2+ more weeks of graded data.`,
    );
  } else {
    push(`| rank | w/wObs | filters | exits | pooled validation | worst fold | hold floor |`);
    push(`| --- | --- | --- | --- | --- | --- | --- |`);
    res.top.slice(0, 15).forEach((r, i) => {
      push(
        `| ${i + 1}${r.calibrated ? " (λ)" : ""} | ${r.model.w}/${r.model.wObs} | ${fmtTrade(r.trade)} | ${r.trade.exitKey} | ${fmtPooled(r.pooledVal)} | $${(r.pooledVal.minFoldPnlCents / 100).toFixed(2)} | ${r.holdPooledPnlCents != null ? `$${(r.holdPooledPnlCents / 100).toFixed(2)}` : "—"} |`,
      );
    });
    push();
    const c = res.chosen;
    push(`### Chosen configuration${c.calibrated ? " (λ-calibrated)" : ""}`);
    push();
    push(`- Blend: w=${c.model.w}, wObs=${c.model.wObs}`);
    push(
      `- Filters: minEv ${c.trade.minEv}, price ${c.trade.minPriceCents}–${c.trade.maxPriceCents}¢, maxProbGap ${c.trade.maxProbGap}, lead ${c.trade.leadMode}, metrics ${c.trade.metricMode}, obsBackedOnly ${c.trade.obsBackedOnly}, excludeCities [${EXCLUDE_CITIES.join(", ")}]`,
    );
    push(`- Exits: ${c.trade.exitKey}; restrictions active: ${c.restrictions} (simplicity tie-break within ${Math.round(TIE_BREAK_BAND * 100)}% band)`);
    push();
    push(`Per fold:`);
    push();
    push(`| fold | train | validation |`);
    push(`| --- | --- | --- |`);
    c.folds.forEach((f, i) => push(`| ${i + 1} | ${fmtSummary(f.train)} | ${fmtSummary(f.val)} |`));
    push();
    push(
      `- Pooled validation: ${fmtPooled(c.pooledVal)}; predicted ${c.pooledVal.avgPredEvCents.toFixed(1)}¢ vs realized ${c.pooledVal.avgRealizedEvCents.toFixed(1)}¢ per contract`,
    );
    push(`- Validation exits: ${JSON.stringify(c.pooledVal.byExit)}`);
    push(
      `- Hold-to-settle floor: $${((c.holdPooledPnlCents ?? 0) / 100).toFixed(2)}; predicted-vs-realized winProb gap ${(c.holdGapPP ?? 0).toFixed(1)}pp`,
    );
    if (c.calibrated && res.productionLambda) {
      push();
      push(`λ table for the production port (fitted on all usable rows):`);
      push();
      push(`| cohort | λ | n |`);
      push(`| --- | --- | --- |`);
      push(`| global | ${res.productionLambda.global} | — |`);
      for (const [k, v] of Object.entries(res.productionLambda.cohorts)) {
        push(`| ${k} | ${v.lambda} | ${v.n} |`);
      }
    }
  }
  push();
  push(`## Acceptance checklist`);
  push();
  push(`| criterion | result | detail |`);
  push(`| --- | --- | --- |`);
  for (const a of res.acceptance) {
    push(`| ${a.criterion} | ${a.pass ? "PASS" : "FAIL"} | ${a.detail} |`);
  }
  push();
  push(
    res.accepted
      ? `**All criteria passed — \`npm run backtest:weather:apply\` may be run.**`
      : `**Acceptance FAILED — do not apply. Stay in micro-mode and collect more data.**`,
  );
  push();
  push(`## Cohort reliability (deduped, at chosen blend weights)`);
  push();
  push(`Positive gap = model overconfidence. The live bot bled for weeks on a ~5pp gap that aggregate P&L hid.`);
  push();
  push(`| cohort | n | predicted | realized | gap (pp) | avg realized EV (¢) |`);
  push(`| --- | --- | --- | --- | --- | --- |`);
  for (const cell of res.cohortTable.filter((t) => t.n >= 20).slice(0, 30)) {
    push(
      `| ${cell.cohort} | ${cell.n} | ${cell.avgPredWinProb.toFixed(2)} | ${cell.realizedWinRate.toFixed(2)} | ${(cell.gap * 100).toFixed(1)} | ${cell.avgRealizedEvCents.toFixed(1)} |`,
    );
  }
  push();
  push(`## Where the edge actually is`);
  push();
  push(
    `The forecast inputs (Open-Meteo ensemble, NWS obs) are public — every serious market participant ` +
      `has them, so there is no informational edge in the forecast itself. The two durable edges this ` +
      `dataset supports: (1) same-day observation latency in the LOCAL AFTERNOON, after the daily high ` +
      `has physically formed and the book lags the settlement station (morning same-day entries were ` +
      `−4¢/contract at 13pp overconfidence; post-16h entries +16¢ with the model underconfident); ` +
      `(2) longshot-bias premium at high prices (80–96¢ favorites trading slightly cheap). At $1 stakes ` +
      `the profit scale is cents per day — stake scaling is gated on 2 consecutive profitable live weeks.`,
  );
  push();
  push(`## Caveats`);
  push();
  push(`- Candidate pool = stored suggestions generated by the live scorer; minEv values below the live floor under-sample the low-edge band.`);
  push(`- Fills at recorded ask + 1¢; exit bids ≈ snapshot probability − 3¢ haircut; no budget/concurrency modeling (fixed $10 stake).`);
  push(`- ~4 weeks of one summer regime; walk-forward folds mitigate but cannot eliminate regime overfit. Keep stakes small until live realized EV matches the backtest.`);
  push(`- Suggestion rows are autocorrelated (hourly re-suggestions); reliability/λ fitting dedups to FIRST-per-ticker (entry-time-honest), the sim dedups one position per ticker+event.`);
  push(`- Re-run weekly: \`npm run backtest:weather:fetch && npm run backtest:weather:run && npm run backtest:weather:report\`.`);
  push();

  mkdirSync("docs", { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n"));
  console.log(`[report] wrote ${REPORT_PATH}`);
}

// --- Apply ----------------------------------------------------------------------

function metricsFor(mode: MetricMode): string[] {
  if (mode === "high_only") return ["temperature_high"];
  if (mode === "high_low") return ["temperature_high", "temperature_low"];
  return ["temperature_high", "temperature_low", "precipitation", "snowfall"];
}

async function apply(): Promise<void> {
  const res = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Results;
  if (!res.chosen) {
    console.error("[apply] results.json has no chosen config — nothing to apply.");
    process.exit(1);
  }
  if (!res.accepted) {
    console.error(
      "[apply] the chosen config FAILED the acceptance checklist — refusing to apply. " +
        "See docs/weather-backtest-report.md; stay in micro-mode instead.",
    );
    process.exit(1);
  }
  const c = res.chosen;
  const exits = EXIT_GRID.find((e) => e.key === c.trade.exitKey)!.exits;
  const patch = {
    minEv: c.trade.minEv,
    minWinProb: FIXED.minWinProb,
    minPriceCents: c.trade.minPriceCents,
    maxPriceCents: c.trade.maxPriceCents,
    maxProbGap: c.trade.maxProbGap,
    metrics: metricsFor(c.trade.metricMode),
    obsBackedOnly: c.trade.obsBackedOnly,
    minLocalHourLead0: c.trade.minLocalHourLead0,
    excludeCities: EXCLUDE_CITIES,
    // Flow retune (applies only alongside an accepted config): afternoon
    // gating compresses ~6-7 trades/day into a burst across 4 time zones,
    // and same-day holds settle next morning — so more concurrent slots and
    // buys per run. Stake size stays $1 until 2 profitable live weeks.
    maxOpenPositions: 8,
    maxBuysPerRun: 3,
    // lead01 must map to the ENFORCING mode — the old mapping to
    // prefer_tomorrow only sorted, which silently widened the live universe.
    targetDateMode:
      c.trade.leadMode === "lead1"
        ? ("tomorrow_only" as const)
        : c.trade.leadMode === "lead01"
          ? ("today_or_tomorrow" as const)
          : ("prefer_tomorrow" as const),
    ...(exits
      ? {
          takeProfitMode: exits.takeProfitMode,
          takeProfitValue: exits.takeProfitValue,
          stopLossEnabled: exits.stopLossEnabled,
          stopLossPct: exits.stopLossPct,
        }
      : {
          // hold-to-settlement: park TP out of reach, stop-loss off
          takeProfitMode: "profit_pct" as const,
          takeProfitValue: 500,
          stopLossEnabled: false,
        }),
  };
  if (c.calibrated) {
    console.warn(
      "[apply] chosen config is λ-CALIBRATED: settings alone do not reproduce it. " +
        "Port the productionLambda table from results.json into src/lib/probCalibration.ts " +
        "(see the report) before re-enabling buys.",
    );
  }
  // Env must be loaded before the db client is imported.
  for (const file of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(join(process.cwd(), file), "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      /* ignore */
    }
  }
  const { getAutomationSettings, saveAutomationSettings } = await import("@/lib/autoSettings");
  const before = await getAutomationSettings();
  console.log("[apply] current settings:", JSON.stringify(before, null, 1));
  console.log("[apply] patch:", JSON.stringify(patch, null, 1));
  const after = await saveAutomationSettings(patch);
  console.log("[apply] saved settings:", JSON.stringify(after, null, 1));
  const { pool } = await import("@/db/client");
  await pool.end();
}

// --- CLI ------------------------------------------------------------------------

const cmd = process.argv[2];
(async () => {
  if (cmd === "fetch") await fetchWeatherDataset();
  else if (cmd === "run") {
    // Re-fetch on missing OR outdated dataset — an old dataset lacks fields
    // new gates depend on (e.g. localHour) and would fail them closed.
    if (!existsSync(join(DATA_DIR, "dataset.json"))) {
      await fetchWeatherDataset();
    } else if ((loadWeatherDataset().version ?? 1) !== WX_DATASET_VERSION) {
      console.log("[run] dataset is an older version — re-fetching");
      await fetchWeatherDataset();
    }
    run();
  } else if (cmd === "report") report();
  else if (cmd === "apply") await apply();
  else {
    console.error("usage: backtest-weather.ts fetch|run|report|apply");
    process.exit(1);
  }
})().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
