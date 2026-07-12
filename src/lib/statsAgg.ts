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
