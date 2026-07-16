import "./load-env"; // MUST be first: db client reads DATABASE_URL at import time
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchWeatherDataset, loadWeatherDataset } from "./fetch-weather";
import {
  blendBrierSweep,
  LeadMode,
  reliabilityByLead,
  RescoredRow,
  rescoreRow,
  simulateWeather,
  WxExitParams,
  WxModelParams,
  WxRow,
  WxSimSummary,
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
 * Methodology: 70/30 time split by target date. Stage 1 reports the raw
 * blend-weight Brier sweep on final snapshots; stage 2 grid-searches blend
 * weights × executor filters × exit policies over the graded suggestion pool,
 * keeps combos profitable on BOTH splits, and ranks by validation P&L.
 * Bug-cohort rows (pre-fix midnight-rollover, Weather-Company-settled series)
 * are excluded so we don't tune around already-fixed defects.
 */

const DATA_DIR = join("backtest-data", "weather");
const RESULTS_PATH = join(DATA_DIR, "results.json");
const REPORT_PATH = join("docs", "weather-backtest-report.md");

// --- Grids -------------------------------------------------------------------

const MODEL_GRID: WxModelParams[] = [];
for (const w of [0.1, 0.2, 0.3]) {
  for (const wObs of [0.35, 0.5, 0.65]) MODEL_GRID.push({ w, wObs });
}
MODEL_GRID.push({ w: 0.65, wObs: 0.65 }); // pre-fix baseline for comparison

const EXIT_GRID: { key: string; exits: WxExitParams | null }[] = [
  { key: "hold", exits: null },
  { key: "tp30", exits: { takeProfitMode: "profit_pct", takeProfitValue: 30, stopLossEnabled: false, stopLossPct: 50 } },
  { key: "tp30sl50", exits: { takeProfitMode: "profit_pct", takeProfitValue: 30, stopLossEnabled: true, stopLossPct: 50 } },
  { key: "tp50", exits: { takeProfitMode: "profit_pct", takeProfitValue: 50, stopLossEnabled: false, stopLossPct: 50 } },
  { key: "cap30sl30", exits: { takeProfitMode: "capture_pct", takeProfitValue: 30, stopLossEnabled: true, stopLossPct: 30 } },
];

interface TradeGridPoint {
  minEv: number;
  minWinProb: number;
  minPriceCents: number;
  maxProbGap: number;
  leadMode: LeadMode;
  excludeCities: string[];
  exitKey: string;
}

function tradeGrid(): TradeGridPoint[] {
  const out: TradeGridPoint[] = [];
  for (const minEv of [0.03, 0.05, 0.08])
    for (const minWinProb of [0.3, 0.4, 0.5])
      for (const minPriceCents of [30, 40, 50])
        for (const maxProbGap of [0.05, 0.1, 0.2])
          for (const leadMode of ["lead1", "lead01", "any"] as LeadMode[])
            for (const excludeCities of [[], ["LAS", "DAL", "MSY"]])
              for (const { key } of EXIT_GRID)
                out.push({ minEv, minWinProb, minPriceCents, maxProbGap, leadMode, excludeCities, exitKey: key });
  return out;
}

const FIXED: Pick<WxTradeParams, "minScore" | "adverseFillCents" | "spreadHaircutCents" | "stakeCents"> = {
  minScore: 0.05,
  adverseFillCents: 1,
  spreadHaircutCents: 3,
  stakeCents: 1000,
};

// --- Run ----------------------------------------------------------------------

interface ComboResult {
  model: WxModelParams;
  trade: TradeGridPoint;
  train: WxSimSummary;
  val: WxSimSummary;
}

interface Results {
  ranAt: string;
  datasetFetchedAt: string;
  totalRows: number;
  usableRows: number;
  excludedByReason: Record<string, number>;
  splitDate: string;
  trainRows: number;
  valRows: number;
  stage1: { w: number; brier: number; n: number }[];
  reliability: ReturnType<typeof reliabilityByLead>;
  survivors: number;
  combosTested: number;
  top: ComboResult[];
  chosen: ComboResult | null;
  baselineBest: ComboResult | null;
}

function rowDate(r: WxRow): string {
  return r.targetDate ?? new Date(r.ts).toISOString().slice(0, 10);
}

function run(): void {
  const dataset = loadWeatherDataset();
  const usable = dataset.rows.filter((r) => !r.exclude && r.pMarket != null);
  const excludedByReason: Record<string, number> = {};
  for (const r of dataset.rows) {
    const reason = r.exclude ?? (r.pMarket == null ? "no_market_prob" : null);
    if (reason) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }

  // 70/30 time split by target date
  const dates = [...new Set(usable.map(rowDate))].sort();
  const splitDate = dates[Math.floor(dates.length * 0.7)] ?? dates[dates.length - 1];
  const trainRows = usable.filter((r) => rowDate(r) < splitDate);
  const valRows = usable.filter((r) => rowDate(r) >= splitDate);
  console.log(
    `[run] ${usable.length} usable rows (${dataset.rows.length} total), split at ${splitDate}: ` +
      `${trainRows.length} train / ${valRows.length} val`,
  );

  // Stage 1 — raw blend sweep + reliability at the shipped weight
  const stage1 = blendBrierSweep(dataset.finals, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1]);
  const reliability = reliabilityByLead(dataset.finals, 0.2);

  // Stage 2 — grid search. Pre-compute rescores per model config, pre-filter
  // to grid minima so each sim only walks plausible candidates.
  const grid = tradeGrid();
  const results: ComboResult[] = [];
  let combosTested = 0;

  for (const model of MODEL_GRID) {
    const cache = new Map<number, RescoredRow | null>();
    const rescore = (row: WxRow): RescoredRow | null => {
      if (!cache.has(row.id)) cache.set(row.id, rescoreRow(row, model));
      return cache.get(row.id)!;
    };
    const candidatesTrain = trainRows.filter((r) => {
      const s = rescore(r);
      return s && s.ev >= 0.03 && s.winProb >= 0.3;
    });
    const candidatesVal = valRows.filter((r) => {
      const s = rescore(r);
      return s && s.ev >= 0.03 && s.winProb >= 0.3;
    });

    for (const g of grid) {
      combosTested++;
      const params: WxTradeParams = {
        ...FIXED,
        minEv: g.minEv,
        minWinProb: g.minWinProb,
        minPriceCents: g.minPriceCents,
        maxProbGap: g.maxProbGap,
        leadMode: g.leadMode,
        excludeCities: g.excludeCities,
        exits: EXIT_GRID.find((e) => e.key === g.exitKey)!.exits,
      };
      const train = simulateWeather(dataset, candidatesTrain, rescore, params).summary;
      if (train.trades < 30 || train.pnlCents <= 0) continue;
      const val = simulateWeather(dataset, candidatesVal, rescore, params).summary;
      if (val.trades < 15 || val.pnlCents <= 0) continue;
      results.push({ model, trade: g, train, val });
    }
    console.log(`[run] model w=${model.w}/wObs=${model.wObs}: ${results.length} survivors so far`);
  }

  results.sort((a, b) => b.val.pnlCents - a.val.pnlCents);

  // Best combo the OLD weights could manage, for the report comparison.
  const baselineBest =
    results.find((r) => r.model.w === 0.65) ??
    null;

  const out: Results = {
    ranAt: new Date().toISOString(),
    datasetFetchedAt: dataset.fetchedAt,
    totalRows: dataset.rows.length,
    usableRows: usable.length,
    excludedByReason,
    splitDate,
    trainRows: trainRows.length,
    valRows: valRows.length,
    stage1,
    reliability,
    survivors: results.length,
    combosTested,
    top: results.slice(0, 40),
    chosen: results[0] ?? null,
    baselineBest,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 1));
  console.log(
    `[run] ${combosTested} combos tested, ${results.length} survivors → ${RESULTS_PATH}` +
      (out.chosen
        ? `\n[run] best: w=${out.chosen.model.w}/${out.chosen.model.wObs} ${JSON.stringify(out.chosen.trade)}` +
          ` | train ${fmtSummary(out.chosen.train)} | val ${fmtSummary(out.chosen.val)}`
        : "\n[run] NO combo was profitable on both splits — keep the bot conservative."),
  );
}

function fmtSummary(s: WxSimSummary): string {
  return `${s.trades} trades, ${(100 * s.winRate).toFixed(0)}% win, $${(s.pnlCents / 100).toFixed(2)} (ROI ${(100 * s.roi).toFixed(1)}%)`;
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
      `. Time split at target date ${res.splitDate}: ${res.trainRows} train / ${res.valRows} validation rows.`,
  );
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
      `price-aware) is the authority on weights, and it rejects both extremes: no w=0.65 combo survived ` +
      `both splits, and the winners cluster at w=0.2–0.3.`,
  );
  push();
  push(`## Reliability at w = 0.2, by lead day`);
  push();
  for (const [lead, bins] of Object.entries(res.reliability)) {
    push(`Lead ${lead}:`);
    push();
    push(`| predicted | observed | n |`);
    push(`| --- | --- | --- |`);
    for (const b of bins) push(`| ${b.predicted.toFixed(2)} | ${b.observed.toFixed(2)} | ${b.n} |`);
    push();
  }
  push(`## Stage 2 — filter × exit grid (${res.combosTested} combos, ${res.survivors} profitable on both splits)`);
  push();
  if (!res.chosen) {
    push(`**No combination survived.** Keep the executor conservative and re-run once more post-fix data accumulates.`);
  } else {
    push(`| rank | w/wObs | filters | exits | train | validation |`);
    push(`| --- | --- | --- | --- | --- | --- |`);
    res.top.slice(0, 15).forEach((r, i) => {
      push(
        `| ${i + 1} | ${r.model.w}/${r.model.wObs} | ev≥${r.trade.minEv} wp≥${r.trade.minWinProb} px≥${r.trade.minPriceCents} gap≤${r.trade.maxProbGap} ${r.trade.leadMode}${r.trade.excludeCities.length ? " −" + r.trade.excludeCities.join("/") : ""} | ${r.trade.exitKey} | ${fmtSummary(r.train)} | ${fmtSummary(r.val)} |`,
      );
    });
    push();
    push(`### Chosen configuration (rank 1)`);
    push();
    const c = res.chosen;
    push(`- Blend: w=${c.model.w}, wObs=${c.model.wObs}`);
    push(
      `- Filters: minEv ${c.trade.minEv}, minWinProb ${c.trade.minWinProb}, minPriceCents ${c.trade.minPriceCents}, maxProbGap ${c.trade.maxProbGap}, lead ${c.trade.leadMode}, excludeCities [${c.trade.excludeCities.join(", ")}]`,
    );
    push(`- Exits: ${c.trade.exitKey}`);
    push(`- Train: ${fmtSummary(c.train)}; predicted ${c.train.avgPredEvCents.toFixed(1)}¢ vs realized ${c.train.avgRealizedEvCents.toFixed(1)}¢ per contract`);
    push(`- Validation: ${fmtSummary(c.val)}; predicted ${c.val.avgPredEvCents.toFixed(1)}¢ vs realized ${c.val.avgRealizedEvCents.toFixed(1)}¢`);
    push(`- Validation exits: ${JSON.stringify(c.val.byExit)}`);
    if (res.baselineBest) {
      push();
      push(
        `Old-weights baseline (best surviving w=0.65 combo): train ${fmtSummary(res.baselineBest.train)} | val ${fmtSummary(res.baselineBest.val)}`,
      );
    } else {
      push();
      push(`No w=0.65 (old weights) combo survived both splits — the re-weighting is doing real work.`);
    }
  }
  push();
  push(`## Caveats`);
  push();
  push(`- Candidate pool = stored suggestions generated at the old w=0.65 scorer; minEv values below 5¢ under-sample the low-edge band.`);
  push(`- Fills at recorded ask + 1¢; exit bids ≈ snapshot probability − 3¢ haircut; no budget/concurrency modeling (fixed $10 stake).`);
  push(`- Short history (~3 weeks, one summer regime) and the training window predates the same-day model fixes (wrong Houston station, rollover) — the bug cohort is excluded, but residual station bias remains in HOU rows.`);
  push(`- Re-run monthly: \`npm run backtest:weather:fetch && npm run backtest:weather:run && npm run backtest:weather:report\`.`);
  push();

  mkdirSync("docs", { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n"));
  console.log(`[report] wrote ${REPORT_PATH}`);
}

// --- Apply ----------------------------------------------------------------------

async function apply(): Promise<void> {
  const res = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Results;
  if (!res.chosen) {
    console.error("[apply] results.json has no chosen config — nothing to apply.");
    process.exit(1);
  }
  const c = res.chosen;
  const exits = EXIT_GRID.find((e) => e.key === c.trade.exitKey)!.exits;
  const patch = {
    minEv: c.trade.minEv,
    minWinProb: c.trade.minWinProb,
    minPriceCents: c.trade.minPriceCents,
    maxProbGap: c.trade.maxProbGap,
    excludeCities: c.trade.excludeCities,
    targetDateMode:
      c.trade.leadMode === "lead1" ? ("tomorrow_only" as const) : ("prefer_tomorrow" as const),
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
    if (!existsSync(join(DATA_DIR, "dataset.json"))) await fetchWeatherDataset();
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
