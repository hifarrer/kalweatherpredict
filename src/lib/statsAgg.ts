/**
 * Shared accuracy-stats aggregation: Brier score, hit rate, and grouping over
 * graded prediction snapshots. Used by both the weather and crypto stats
 * routes.
 */

export interface GradedRow {
  market_ticker: string;
  event_ticker: string;
  city_code: string | null;
  asset: string | null;
  metric: string;
  lead_days: number | null;
  tau_hours: number | null;
  forecast_value: number | null;
  predicted_prob: number;
  market_prob: number | null;
  target_date: string | null;
  result: string;
  actual_value: number | null;
  settled_at: string | null;
  title: string | null;
}

export interface StatsGroup {
  key: string;
  count: number;
  hitRate: number;
  brier: number;
  marketBrier: number | null;
}

export function computeGroup(key: string, rows: GradedRow[]): StatsGroup {
  let hits = 0;
  let brierSum = 0;
  let marketBrierSum = 0;
  let marketCount = 0;

  for (const r of rows) {
    const outcome = r.result === "yes" ? 1 : 0;
    const prob = Number(r.predicted_prob);
    if ((prob > 0.5 ? 1 : 0) === outcome) hits++;
    brierSum += (prob - outcome) ** 2;
    if (r.market_prob !== null) {
      marketBrierSum += (Number(r.market_prob) - outcome) ** 2;
      marketCount++;
    }
  }

  return {
    key,
    count: rows.length,
    hitRate: rows.length > 0 ? hits / rows.length : 0,
    brier: rows.length > 0 ? brierSum / rows.length : 0,
    marketBrier: marketCount > 0 ? marketBrierSum / marketCount : null,
  };
}

export function groupBy(
  rows: GradedRow[],
  keyFn: (r: GradedRow) => string | null,
): StatsGroup[] {
  const groups = new Map<string, GradedRow[]>();
  for (const r of rows) {
    const key = keyFn(r);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => computeGroup(key, groupRows))
    .sort((a, b) => b.count - a.count);
}

export interface DailyAccuracyPoint {
  day: string; // "YYYY-MM-DD" — market target day (or ET settlement date)
  n: number;
  hitRate: number;
  brier: number;
  marketBrier: number | null;
}

// Kalshi's exchange day; keeps buckets aligned with botStats.BUCKET_TZ.
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Accuracy metrics bucketed by the market's target day (falling back to the
 * settlement timestamp's ET date). target_date is preferred because stored
 * settled_at is Kalshi's latest_expiration_time, which can sit days in the
 * future for early-settled markets.
 */
export function dailyAccuracy(rows: GradedRow[]): DailyAccuracyPoint[] {
  const byDay = new Map<string, GradedRow[]>();
  for (const r of rows) {
    const day =
      r.target_date ??
      (r.settled_at ? dayFormatter.format(new Date(r.settled_at)) : null);
    if (!day) continue;
    const arr = byDay.get(day) ?? [];
    arr.push(r);
    byDay.set(day, arr);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, dayRows]) => {
      const g = computeGroup(day, dayRows);
      return {
        day,
        n: g.count,
        hitRate: g.hitRate,
        brier: g.brier,
        marketBrier: g.marketBrier,
      };
    });
}

export interface ReliabilityPoint {
  midpoint: number; // center of the predicted-probability bucket
  observed: number; // fraction of the bucket that settled YES
  n: number;
}

/**
 * Calibration curve: bucket predictions by predicted_prob and compare each
 * bucket's midpoint against the observed YES frequency. Perfectly calibrated
 * predictions lie on the y = x diagonal. Empty buckets are dropped.
 */
export function reliabilityCurve(
  rows: GradedRow[],
  buckets = 10,
): ReliabilityPoint[] {
  const yes = new Array<number>(buckets).fill(0);
  const total = new Array<number>(buckets).fill(0);
  for (const r of rows) {
    const prob = Number(r.predicted_prob);
    if (!Number.isFinite(prob)) continue;
    const idx = Math.min(Math.floor(prob * buckets), buckets - 1);
    total[idx]++;
    if (r.result === "yes") yes[idx]++;
  }
  const out: ReliabilityPoint[] = [];
  for (let i = 0; i < buckets; i++) {
    if (total[i] === 0) continue;
    out.push({
      midpoint: (i + 0.5) / buckets,
      observed: yes[i] / total[i],
      n: total[i],
    });
  }
  return out;
}
