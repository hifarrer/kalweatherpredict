import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXCLUDED_WEATHER_SERIES } from "@/lib/weatherSeries";
import { WxDataset, WxFinal, WxRow, WxSnapPoint } from "./replay-weather";

/**
 * Weather backtest dataset fetcher.
 *
 * Unlike the crypto backtest (which rebuilds prices from exchange candles),
 * the weather harness replays the app's own recorded history: graded
 * `suggestions` are the candidate pool (each row carries the suggested side's
 * ask, fee, model/market/blended probabilities at decision time), hourly
 * `prediction_snapshots` provide a market-price path for exit simulation, and
 * `settlements` provide outcomes.
 *
 * Known-bug cohorts are marked (not dropped) so the replay can exclude them:
 *  - target_mismatch: the pre-fix midnight-rollover rows (scored for the
 *    wrong day; 99.7% of them lost) — tuning around them would be tuning
 *    around a fixed bug;
 *  - twc_series: series settled by The Weather Company (hourly KXTEMP*H,
 *    KXHOLIDAY*, bare KXRAIN), which the model no longer predicts.
 */

const DATA_DIR = join("backtest-data", "weather");
const DATASET_PATH = join(DATA_DIR, "dataset.json");

function loadEnv(): void {
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
      // ignore
    }
  }
}

export async function fetchWeatherDataset(): Promise<WxDataset> {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const { pool } = await import("@/db/client");

  // --- Decision rows: graded weather suggestions joined to settlements ---
  const rowsRes = await pool.query(`
    SELECT s.id, s.market_ticker, s.event_ticker, s.side, s.kind, s.source,
           s.price, s.forecast_prob, s.blended_prob, s.win_prob, s.market_prob,
           s.fee_per_contract, s.volume_24h, s.city_code, s.metric, s.lead_days,
           s.target_date AS sugg_target, s.decided, s.obs_backed, s.blend_w,
           extract(epoch FROM s.created_at) * 1000 AS ts,
           st.result, st.target_date AS settle_target
    FROM suggestions s
    JOIN settlements st ON st.market_ticker = s.market_ticker
    WHERE s.section = 'weather' AND s.graded_at IS NOT NULL
      AND st.result IN ('yes', 'no')
    ORDER BY s.created_at
  `);

  const rows: WxRow[] = rowsRes.rows.map((r) => {
    let exclude: string | null = null;
    if (EXCLUDED_WEATHER_SERIES.test(r.market_ticker)) exclude = "twc_series";
    else if (r.sugg_target && r.settle_target && r.sugg_target !== r.settle_target) {
      exclude = "target_mismatch";
    }
    return {
      id: Number(r.id),
      ticker: r.market_ticker,
      event: r.event_ticker,
      side: r.side,
      kind: r.kind,
      source: r.source,
      price: Number(r.price),
      pModel: Number(r.forecast_prob),
      pBlendStored: Number(r.blended_prob),
      winProbStored: Number(r.win_prob),
      pMarket: r.market_prob === null ? null : Number(r.market_prob),
      fee: Number(r.fee_per_contract),
      vol24: r.volume_24h === null ? null : Number(r.volume_24h),
      city: r.city_code,
      metric: r.metric,
      lead: r.lead_days === null ? null : Number(r.lead_days),
      targetDate: r.settle_target ?? r.sugg_target ?? null,
      ts: Number(r.ts),
      result: r.result,
      exclude,
      decided: r.decided,
      obsBacked: r.obs_backed,
      blendW: r.blend_w === null ? null : Number(r.blend_w),
    };
  });

  // --- Market-price path for exit simulation (hourly snapshots) ---
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const snaps: Record<string, WxSnapPoint[]> = {};
  const CHUNK = 500;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const snapRes = await pool.query(
      `SELECT market_ticker, extract(epoch FROM captured_at) * 1000 AS ts, market_prob
       FROM prediction_snapshots
       WHERE section = 'weather' AND market_prob IS NOT NULL AND market_ticker = ANY($1)
       ORDER BY market_ticker, captured_at`,
      [tickers.slice(i, i + CHUNK)],
    );
    for (const s of snapRes.rows) {
      (snaps[s.market_ticker] ??= []).push({ ts: Number(s.ts), mp: Number(s.market_prob) });
    }
  }

  // --- Final snapshots for the stage-1 blend-weight sweep (all settled markets) ---
  const finalsRes = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (s.market_ticker) s.market_ticker, s.predicted_prob,
             s.market_prob, s.lead_days, s.target_date
      FROM prediction_snapshots s
      WHERE s.section = 'weather'
      ORDER BY s.market_ticker, s.is_final DESC, s.captured_at DESC
    )
    SELECT l.market_ticker, l.predicted_prob, l.market_prob, l.lead_days,
           l.target_date AS snap_target, st.target_date AS settle_target, st.result
    FROM latest l
    JOIN settlements st ON st.market_ticker = l.market_ticker
    WHERE l.predicted_prob IS NOT NULL AND l.market_prob IS NOT NULL
      AND st.result IN ('yes', 'no')
  `);
  const finals: WxFinal[] = finalsRes.rows.map((r) => {
    let exclude: string | null = null;
    if (EXCLUDED_WEATHER_SERIES.test(r.market_ticker)) exclude = "twc_series";
    else if (r.snap_target && r.settle_target && r.snap_target !== r.settle_target) {
      exclude = "target_mismatch";
    }
    return {
      ticker: r.market_ticker,
      pModel: Number(r.predicted_prob),
      pMarket: Number(r.market_prob),
      lead: r.lead_days === null ? null : Number(r.lead_days),
      y: r.result === "yes" ? 1 : 0,
      exclude,
    };
  });

  await pool.end();

  const dataset: WxDataset = {
    fetchedAt: new Date().toISOString(),
    rows,
    snaps,
    finals,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATASET_PATH, JSON.stringify(dataset));
  const excluded = rows.filter((r) => r.exclude).length;
  console.log(
    `[fetch-weather] ${rows.length} graded decision rows (${excluded} bug-cohort-marked), ` +
      `${tickers.length} markets, ${Object.values(snaps).reduce((a, b) => a + b.length, 0)} snapshot points, ` +
      `${finals.length} final snapshots → ${DATASET_PATH}`,
  );
  return dataset;
}

export function loadWeatherDataset(): WxDataset {
  return JSON.parse(readFileSync(DATASET_PATH, "utf8")) as WxDataset;
}
