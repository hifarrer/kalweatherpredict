import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CryptoModelParams, DEFAULT_CRYPTO_PARAMS, HorizonWeights } from "@/lib/crypto/params";
import { fetchDataset, loadDataset } from "./fetch";
import {
  buildRawSteps,
  DEFAULT_REPLAY_OPTS,
  modelDiagnostics,
  ModelDiagnostics,
  scoreSteps,
  ScoredStep,
  simulateTrading,
  SimSummary,
  TradeParams,
} from "./replay";
import { BtDataset } from "./btypes";

/**
 * Crypto strategy backtest CLI.
 *
 *   npm run backtest:fetch -- --days 10          # pull data into backtest-data/
 *   npm run backtest:run   -- --grid quick|full  # grid-search, write results
 *   npm run backtest:report                      # render docs/backtest-report.md
 *
 * Methodology: 70/30 time split by event close. Stage 1 picks model params
 * (vol estimation) by train-split Brier; stage 2 grid-searches the trade
 * filters on the train split and ranks survivors (profitable on BOTH splits)
 * by validation P&L. See docs/backtest-report.md for the recorded outcome.
 */

const DATA_DIR = "backtest-data";
const RESULTS_PATH = join(DATA_DIR, "results.json");

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

// --- Model parameter grid -----------------------------------------------------

const PRESETS: Record<string, HorizonWeights> = {
  short: {
    "0-15m": { rv30m: 0.7, rv2h: 0.25, rv8h: 0.05, rv24h: 0 },
    "15-60m": { rv30m: 0.5, rv2h: 0.35, rv8h: 0.1, rv24h: 0.05 },
    "1-4h": { rv30m: 0.2, rv2h: 0.45, rv8h: 0.25, rv24h: 0.1 },
    "4-24h": { rv30m: 0, rv2h: 0.25, rv8h: 0.45, rv24h: 0.3 },
    "24h+": { rv30m: 0, rv2h: 0, rv8h: 0.3, rv24h: 0.7 },
  },
  balanced: DEFAULT_CRYPTO_PARAMS.horizonWeights,
  long: {
    "0-15m": { rv30m: 0.3, rv2h: 0.3, rv8h: 0.2, rv24h: 0.2 },
    "15-60m": { rv30m: 0.2, rv2h: 0.3, rv8h: 0.25, rv24h: 0.25 },
    "1-4h": { rv30m: 0.05, rv2h: 0.25, rv8h: 0.35, rv24h: 0.35 },
    "4-24h": { rv30m: 0, rv2h: 0.1, rv8h: 0.4, rv24h: 0.5 },
    "24h+": { rv30m: 0, rv2h: 0, rv8h: 0.2, rv24h: 0.8 },
  },
};

interface ModelCombo {
  id: string;
  params: CryptoModelParams;
}

function modelGrid(kind: "quick" | "full"): ModelCombo[] {
  const volModes: ("rms" | "ewma")[] = ["rms", "ewma"];
  const presets = Object.keys(PRESETS);
  const betas = kind === "full" ? [0, 0.25, 0.4, 0.6] : [0, 0.4];
  const mults = kind === "full" ? [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5] : [1.0, 1.2, 1.4];

  const combos: ModelCombo[] = [];
  for (const volMode of volModes)
    for (const preset of presets)
      for (const ivBlendBeta of betas)
        for (const volMultiplier of mults)
          combos.push({
            id: `${volMode}/${preset}/β${ivBlendBeta}/m${volMultiplier}`,
            params: {
              ...DEFAULT_CRYPTO_PARAMS,
              volMode,
              horizonWeights: PRESETS[preset],
              ivBlendBeta,
              volMultiplier,
            },
          });
  return combos;
}

// --- Trade parameter grid -------------------------------------------------------

const BASE_TRADE: TradeParams = {
  minEv: 0.05,
  minWinProb: 0.4,
  minPriceCents: 40,
  maxProbGap: 0.35,
  maxTauHours: 6,
  minTauMinutes: 5,
  maxSpreadCents: 10,
  minVolume: 100,
  spotBackedMaxTauMin: 30,
  spotBackedMinZ: 2,
  adverseFillCents: 1,
  stakeCents: 1000,
  exits: null,
};

function tradeGrid(kind: "quick" | "full"): TradeParams[] {
  const minEvs = [0.03, 0.05, 0.08];
  const minWinProbs = [0.3, 0.4, 0.5];
  const minPrices = [30, 40, 50];
  const maxTaus = kind === "full" ? [1, 3, 6, 12] : [1, 3, 6];
  const gaps = [0.2, 0.35, 0.5];
  const sbTaus = kind === "full" ? [15, 30, 45] : [30];
  const exitModes: TradeParams["exits"][] = [
    null,
    { takeProfitPct: 30, stopLossPct: 50 },
  ];

  const out: TradeParams[] = [];
  for (const minEv of minEvs)
    for (const minWinProb of minWinProbs)
      for (const minPriceCents of minPrices)
        for (const maxTauHours of maxTaus)
          for (const maxProbGap of gaps)
            for (const spotBackedMaxTauMin of sbTaus)
              for (const exits of exitModes)
                out.push({
                  ...BASE_TRADE,
                  minEv,
                  minWinProb,
                  minPriceCents,
                  maxTauHours,
                  maxProbGap,
                  spotBackedMaxTauMin,
                  exits,
                });
  return out;
}

function tradeId(p: TradeParams): string {
  return `ev${Math.round(p.minEv * 100)}/wp${p.minWinProb}/px${p.minPriceCents}/τ${p.maxTauHours}h/gap${p.maxProbGap}/sb${p.spotBackedMaxTauMin}m/${p.exits ? "tpsl" : "hold"}`;
}

// --- Results shapes ---------------------------------------------------------------

interface ComboResult {
  modelId: string;
  tradeId: string;
  train: SimSummary;
  val: SimSummary;
}

interface RunResults {
  ranAt: string;
  dataset: { fetchedAt: string; days: number; events: number; trainEvents: number; valEvents: number; splitTs: string };
  grid: string;
  modelLeaderboard: { id: string; trainBrier: number; valBrier: number; marketBrier: number; n: number }[];
  bestModel: { id: string; params: CryptoModelParams; diagnostics: ModelDiagnostics };
  results: ComboResult[];
  chosen: ComboResult | null;
}

// --- run ---------------------------------------------------------------------------

async function run(kind: "quick" | "full") {
  const dataset = loadDataset();
  console.log(
    `[run] dataset: ${dataset.events.length} events, fetched ${dataset.fetchedAt}, grid=${kind}`,
  );
  if (dataset.events.length < 50) {
    console.warn("[run] WARNING: fewer than 50 events — results will be noisy");
  }

  // 70/30 time split by event close
  const closes = dataset.events.map((e) => e.closeTs).sort((a, b) => a - b);
  const splitTs = closes[Math.floor(closes.length * 0.7)];
  const trainEventIdx = new Set<number>();
  const valEventIdx = new Set<number>();
  dataset.events.forEach((e, i) => (e.closeTs < splitTs ? trainEventIdx : valEventIdx).add(i));
  console.log(
    `[run] split at ${new Date(splitTs).toISOString()}: train=${trainEventIdx.size} val=${valEventIdx.size}`,
  );

  // Raw steps per volMode (the expensive part)
  const rawByVolMode = new Map<string, ReturnType<typeof buildRawSteps>>();
  for (const volMode of ["rms", "ewma"] as const) {
    console.log(`[run] building raw steps (${volMode})...`);
    rawByVolMode.set(
      volMode,
      buildRawSteps(dataset, { ...DEFAULT_CRYPTO_PARAMS, volMode }, DEFAULT_REPLAY_OPTS),
    );
    console.log(`[run]   ${rawByVolMode.get(volMode)!.length} steps`);
  }

  // Stage 1: model selection by train Brier
  console.log(`[run] stage 1: scoring ${modelGrid(kind).length} model combos...`);
  const modelRows: RunResults["modelLeaderboard"] = [];
  const scoredCache = new Map<string, ScoredStep[]>();
  for (const combo of modelGrid(kind)) {
    const raw = rawByVolMode.get(combo.params.volMode)!;
    const scored = scoreSteps(raw, combo.params);
    const train = scored.filter((s) => trainEventIdx.has(s.eventIdx));
    const val = scored.filter((s) => valEventIdx.has(s.eventIdx));
    const dTrain = modelDiagnostics(train);
    const dVal = modelDiagnostics(val);
    modelRows.push({
      id: combo.id,
      trainBrier: dTrain.brierModel,
      valBrier: dVal.brierModel,
      marketBrier: dTrain.brierMarket,
      n: dTrain.n,
    });
    scoredCache.set(combo.id, scored);
  }
  modelRows.sort((a, b) => a.trainBrier - b.trainBrier);
  console.log(`[run] best models by train Brier:`);
  for (const r of modelRows.slice(0, 5)) {
    console.log(
      `  ${r.id}: train ${r.trainBrier.toFixed(4)} val ${r.valBrier.toFixed(4)} (market ${r.marketBrier.toFixed(4)}, n=${r.n})`,
    );
  }

  // Stage 2: trade grid on the top model combos
  const topModels = modelRows.slice(0, 3);
  const grid = tradeGrid(kind);
  console.log(
    `[run] stage 2: ${grid.length} trade combos × ${topModels.length} models...`,
  );
  const results: ComboResult[] = [];
  const modelParamsById = new Map(modelGrid(kind).map((c) => [c.id, c.params]));

  for (const model of topModels) {
    const scored = scoredCache.get(model.id)!;
    const trainSteps = scored.filter((s) => trainEventIdx.has(s.eventIdx));
    const valSteps = scored.filter((s) => valEventIdx.has(s.eventIdx));
    for (const tp of grid) {
      const train = simulateTrading(dataset, trainSteps, tp).summary;
      if (train.trades < 20 || train.pnlCents <= 0) continue; // dead on train — skip val
      const val = simulateTrading(dataset, valSteps, tp).summary;
      results.push({ modelId: model.id, tradeId: tradeId(tp), train, val });
    }
  }

  // Rank: profitable on both splits, by validation P&L
  const survivors = results
    .filter((r) => r.train.pnlCents > 0 && r.val.pnlCents > 0 && r.val.trades >= 10)
    .sort((a, b) => b.val.pnlCents - a.val.pnlCents);

  console.log(`\n[run] ${results.length} train-profitable combos, ${survivors.length} survive validation. Top 10:`);
  for (const r of survivors.slice(0, 10)) {
    console.log(
      `  ${r.modelId} | ${r.tradeId}\n    train: ${fmt(r.train)}\n    val:   ${fmt(r.val)}`,
    );
  }

  const chosen = survivors[0] ?? null;
  const bestModelId = chosen?.modelId ?? modelRows[0].id;
  const bestScored = scoredCache.get(bestModelId)!;

  const out: RunResults = {
    ranAt: new Date().toISOString(),
    dataset: {
      fetchedAt: dataset.fetchedAt,
      days: dataset.days,
      events: dataset.events.length,
      trainEvents: trainEventIdx.size,
      valEvents: valEventIdx.size,
      splitTs: new Date(splitTs).toISOString(),
    },
    grid: kind,
    modelLeaderboard: modelRows.slice(0, 15),
    bestModel: {
      id: bestModelId,
      params: modelParamsById.get(bestModelId)!,
      diagnostics: modelDiagnostics(bestScored),
    },
    results: survivors.slice(0, 50),
    chosen,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
  console.log(`\n[run] results written to ${RESULTS_PATH}`);
  if (chosen) {
    console.log(`[run] CHOSEN: ${chosen.modelId} | ${chosen.tradeId}`);
  } else {
    console.log("[run] NO combo was profitable on both splits — do not enable auto-trading");
  }
}

function fmt(s: SimSummary): string {
  return `${s.trades} trades, P&L $${(s.pnlCents / 100).toFixed(2)}, win ${(s.winRate * 100).toFixed(0)}%, ROI ${(s.roi * 100).toFixed(1)}%, maxDD $${(s.maxDrawdownCents / 100).toFixed(2)}, predEV ${s.avgPredEvCents.toFixed(1)}¢ vs realized ${s.avgRealizedEvCents.toFixed(1)}¢`;
}

// --- report --------------------------------------------------------------------------

function report() {
  if (!existsSync(RESULTS_PATH)) throw new Error("No results — run `npm run backtest:run` first");
  const r = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as RunResults;

  const lines: string[] = [];
  lines.push(`# Crypto Strategy Backtest Report`);
  lines.push(``);
  lines.push(`Generated: ${r.ranAt} · Grid: \`${r.grid}\``);
  lines.push(``);
  lines.push(`## Dataset`);
  lines.push(``);
  lines.push(`- ${r.dataset.events} settled Kalshi crypto events (${r.dataset.days} days, fetched ${r.dataset.fetchedAt})`);
  lines.push(`- Time split at ${r.dataset.splitTs}: ${r.dataset.trainEvents} train / ${r.dataset.valEvents} validation events`);
  lines.push(`- Replay: real per-minute Kalshi bid/ask candlesticks; fills at ask + 1¢ adverse haircut; Kalshi quadratic fee per contract; $10 fixed stake; one position per event ladder.`);
  lines.push(``);
  lines.push(`## Model selection (stage 1 — Brier score on train split)`);
  lines.push(``);
  lines.push(`| Model (volMode/preset/ivβ/mult) | Train Brier | Val Brier | Market Brier | Samples |`);
  lines.push(`|---|---|---|---|---|`);
  for (const m of r.modelLeaderboard.slice(0, 10)) {
    lines.push(
      `| ${m.id} | ${m.trainBrier.toFixed(4)} | ${m.valBrier.toFixed(4)} | ${m.marketBrier.toFixed(4)} | ${m.n} |`,
    );
  }
  lines.push(``);
  lines.push(`## Best model diagnostics (${r.bestModel.id})`);
  lines.push(``);
  lines.push(`| τ bucket | Samples | Model Brier | Market Brier |`);
  lines.push(`|---|---|---|---|`);
  for (const [bucket, d] of Object.entries(r.bestModel.diagnostics.byBucket)) {
    lines.push(`| ${bucket} | ${d.n} | ${d.brierModel.toFixed(4)} | ${d.brierMarket.toFixed(4)} |`);
  }
  lines.push(``);
  lines.push(`Calibration (predicted vs realized YES rate):`);
  lines.push(``);
  lines.push(`| Predicted bin | Samples | Mean predicted | Realized |`);
  lines.push(`|---|---|---|---|`);
  for (const c of r.bestModel.diagnostics.calibration) {
    if (c.n === 0) continue;
    lines.push(`| ${c.bin} | ${c.n} | ${(c.predicted * 100).toFixed(1)}% | ${(c.realized * 100).toFixed(1)}% |`);
  }
  lines.push(``);
  lines.push(`## Strategy results (stage 2 — profitable on both splits, ranked by validation P&L)`);
  lines.push(``);
  lines.push(`| Model | Filters | Split | Trades | Win rate | P&L | ROI | Max DD | Pred EV | Realized EV |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const row of r.results.slice(0, 15)) {
    for (const [split, s] of [["train", row.train], ["val", row.val]] as const) {
      lines.push(
        `| ${row.modelId} | ${row.tradeId} | ${split} | ${s.trades} | ${(s.winRate * 100).toFixed(0)}% | $${(s.pnlCents / 100).toFixed(2)} | ${(s.roi * 100).toFixed(1)}% | $${(s.maxDrawdownCents / 100).toFixed(2)} | ${s.avgPredEvCents.toFixed(1)}¢ | ${s.avgRealizedEvCents.toFixed(1)}¢ |`,
      );
    }
  }
  lines.push(``);
  if (r.chosen) {
    lines.push(`## Chosen configuration`);
    lines.push(``);
    lines.push(`**${r.chosen.modelId}** with filters **${r.chosen.tradeId}**`);
    lines.push(``);
    lines.push(`- Train: ${fmt(r.chosen.train)}`);
    lines.push(`- Validation: ${fmt(r.chosen.val)}`);
    lines.push(``);
    lines.push(`These values are baked into \`DEFAULT_CRYPTO_PARAMS\` (src/lib/crypto/params.ts) and the crypto automation defaults (src/lib/crypto/cryptoSettings.ts).`);
  } else {
    lines.push(`## No profitable configuration`);
    lines.push(``);
    lines.push(`No parameter set was profitable on both splits. Auto-trading should remain disabled until a later run with more data finds one.`);
  }
  lines.push(``);
  lines.push(`## Caveats`);
  lines.push(``);
  lines.push(`- Fills are simulated at the posted ask (+1¢) with no queue/impact modeling; real IOC fills can be worse in fast markets.`);
  lines.push(`- Coinbase spot proxies the CF Benchmarks settlement index; small basis differences exist.`);
  lines.push(`- The window is short (${r.dataset.days} days) and one vol regime; re-run the backtest periodically (\`npm run backtest:fetch && npm run backtest:run\`) as settled data accumulates.`);
  lines.push(``);

  mkdirSync("docs", { recursive: true });
  writeFileSync(join("docs", "backtest-report.md"), lines.join("\n"));
  console.log("[report] wrote docs/backtest-report.md");
}

// --- main ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "fetch":
      await fetchDataset({
        days: parseInt(arg("days", "10"), 10),
        maxEventsPerSeries: parseInt(arg("max-events", "250"), 10),
        assets: arg("assets", "BTC,ETH").split(","),
      });
      break;
    case "run":
      await run(arg("grid", "quick") === "full" ? "full" : "quick");
      break;
    case "report":
      report();
      break;
    default:
      console.log("Usage: backtest-crypto.ts <fetch|run|report> [--days N] [--grid quick|full]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
