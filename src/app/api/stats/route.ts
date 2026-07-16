import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { leadBucket } from "@/lib/calibration";
import { getSigmaCalibration } from "@/lib/calibrationStore";
import { CITY_MAP } from "@/lib/cities";
import {
  computeGroup,
  dailyAccuracy,
  GradedRow,
  groupBy,
  reliabilityCurve,
} from "@/lib/statsAgg";
import { getBotPerfCharts, getEvMonitor } from "@/lib/botStats";

export const dynamic = "force-dynamic";

export type { StatsGroup } from "@/lib/statsAgg";

export async function GET(req: NextRequest) {
  try {
    // Optional city filter — applies to the "recently graded" list only;
    // aggregates stay global so the breakdown cards don't shift.
    const cityParam = req.nextUrl.searchParams.get("city");
    const city = cityParam && CITY_MAP[cityParam] ? cityParam : null;
    // For each settled market: its final snapshot if one exists, otherwise
    // the last snapshot captured while the market was still open.
    const result = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (s.market_ticker) *
        FROM prediction_snapshots s
        WHERE s.section = 'weather'
        ORDER BY s.market_ticker, s.is_final DESC, s.captured_at DESC
      )
      SELECT l.market_ticker, l.event_ticker, l.city_code, l.metric, l.lead_days,
             l.forecast_value, l.predicted_prob, l.market_prob,
             COALESCE(l.target_date, st.target_date) AS target_date,
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
    const botPerf = await getBotPerfCharts("weather");
    const evMonitor = await getEvMonitor("weather");

    return NextResponse.json({
      charts: {
        ...botPerf,
        accuracyDaily: dailyAccuracy(rows),
        reliability: reliabilityCurve(rows),
      },
      overall: computeGroup("overall", rows),
      forecastMae: maeCount > 0 ? maeSum / maeCount : null,
      forecastMaeCount: maeCount,
      byCity: groupBy(rows, (r) => r.city_code),
      byMetric: groupBy(rows, (r) => r.metric),
      byLead: groupBy(rows, (r) =>
        r.lead_days !== null ? leadBucket(Number(r.lead_days)) : null,
      ),
      calibration,
      evMonitor,
      recent: (city ? rows.filter((r) => r.city_code === city) : rows).slice(0, 50).map((r) => ({
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
