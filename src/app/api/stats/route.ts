import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { leadBucket } from "@/lib/calibration";
import { getSigmaCalibration } from "@/lib/calibrationStore";

export const dynamic = "force-dynamic";

interface GradedRow {
  market_ticker: string;
  event_ticker: string;
  city_code: string | null;
  metric: string;
  lead_days: number | null;
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

function computeGroup(key: string, rows: GradedRow[]): StatsGroup {
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

function groupBy(rows: GradedRow[], keyFn: (r: GradedRow) => string | null): StatsGroup[] {
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

export async function GET() {
  try {
    // For each settled market: its final snapshot if one exists, otherwise
    // the last snapshot captured while the market was still open.
    const result = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (s.market_ticker) *
        FROM prediction_snapshots s
        ORDER BY s.market_ticker, s.is_final DESC, s.captured_at DESC
      )
      SELECT l.market_ticker, l.event_ticker, l.city_code, l.metric, l.lead_days,
             l.forecast_value, l.predicted_prob, l.market_prob, l.target_date,
             st.result, st.actual_value, st.settled_at, e.title
      FROM latest l
      JOIN settlements st ON st.market_ticker = l.market_ticker
      LEFT JOIN events e ON e.event_ticker = l.event_ticker
      ORDER BY st.settled_at DESC NULLS LAST, st.created_at DESC
    `);

    const rows = result.rows as unknown as GradedRow[];

    // Forecast error (MAE) — one sample per event: bracket markets within an
    // event share the same forecast/actual pair.
    const seenEvents = new Set<string>();
    let maeSum = 0;
    let maeCount = 0;
    for (const r of rows) {
      if (r.forecast_value === null || r.actual_value === null) continue;
      if (seenEvents.has(r.event_ticker)) continue;
      seenEvents.add(r.event_ticker);
      maeSum += Math.abs(Number(r.actual_value) - Number(r.forecast_value));
      maeCount++;
    }

    const calibration = await getSigmaCalibration();

    return NextResponse.json({
      overall: computeGroup("overall", rows),
      forecastMae: maeCount > 0 ? maeSum / maeCount : null,
      forecastMaeCount: maeCount,
      byCity: groupBy(rows, (r) => r.city_code),
      byMetric: groupBy(rows, (r) => r.metric),
      byLead: groupBy(rows, (r) =>
        r.lead_days !== null ? leadBucket(Number(r.lead_days)) : null,
      ),
      calibration,
      recent: rows.slice(0, 50).map((r) => ({
        marketTicker: r.market_ticker,
        title: r.title,
        cityCode: r.city_code,
        metric: r.metric,
        targetDate: r.target_date,
        predictedProb: Number(r.predicted_prob),
        marketProb: r.market_prob !== null ? Number(r.market_prob) : null,
        result: r.result,
        forecastValue: r.forecast_value !== null ? Number(r.forecast_value) : null,
        actualValue: r.actual_value !== null ? Number(r.actual_value) : null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Stats API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
