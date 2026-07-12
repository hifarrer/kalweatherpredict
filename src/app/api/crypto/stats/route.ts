import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { computeGroup, GradedRow, groupBy } from "@/lib/statsAgg";
import { tauBucket } from "@/lib/crypto/params";
import { getCryptoVolCalibration } from "@/lib/crypto/cryptoVolCalibration";

export const dynamic = "force-dynamic";

/**
 * Crypto prediction accuracy: for each settled crypto market, its final (or
 * latest) snapshot joined to the settlement, aggregated by asset and by
 * time-to-settlement bucket. The calibration table is the per-bucket σ
 * correction (RMS of standardized outcomes — 1.0 means σ is right).
 */
export async function GET() {
  try {
    const result = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (s.market_ticker) *
        FROM prediction_snapshots s
        WHERE s.section = 'crypto'
        ORDER BY s.market_ticker, s.is_final DESC, s.captured_at DESC
      )
      SELECT l.market_ticker, l.event_ticker, l.city_code, l.asset, l.metric,
             l.lead_days, l.tau_hours, l.forecast_value, l.predicted_prob,
             l.market_prob, l.target_date,
             st.result, st.actual_value, st.settled_at, e.title
      FROM latest l
      JOIN settlements st ON st.market_ticker = l.market_ticker
      LEFT JOIN events e ON e.event_ticker = l.event_ticker
      ORDER BY st.settled_at DESC NULLS LAST, st.created_at DESC
    `);

    const rows = result.rows as unknown as GradedRow[];
    const calibration = await getCryptoVolCalibration();

    return NextResponse.json({
      overall: computeGroup("overall", rows),
      byAsset: groupBy(rows, (r) => r.asset),
      byTauBucket: groupBy(rows, (r) =>
        r.tau_hours !== null ? tauBucket(Number(r.tau_hours)) : null,
      ),
      calibration,
      recent: rows.slice(0, 50).map((r) => ({
        marketTicker: r.market_ticker,
        title: r.title,
        asset: r.asset,
        targetDate: r.target_date,
        tauHours: r.tau_hours !== null ? Number(r.tau_hours) : null,
        predictedProb: Number(r.predicted_prob),
        marketProb: r.market_prob !== null ? Number(r.market_prob) : null,
        result: r.result,
        forecastValue: r.forecast_value !== null ? Number(r.forecast_value) : null,
        actualValue: r.actual_value !== null ? Number(r.actual_value) : null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Crypto stats API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
