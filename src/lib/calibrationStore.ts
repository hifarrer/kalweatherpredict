import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { syncMeta } from "@/db/schema";
import { SigmaCalibration } from "@/lib/calibration";

/**
 * Server-only persistence for the sigma calibration table
 * (see calibration.ts for the types and bucket logic).
 */

const META_KEY = "sigma_calibration";
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { data: SigmaCalibration | null; ts: number } | null = null;

/**
 * Recompute the calibration table from snapshots joined to settlements and
 * persist it to sync_meta. One error sample per (event, lead-day) — bracket
 * markets within an event share the same forecast/actual values, so counting
 * each market would multiply identical samples.
 */
export async function recomputeSigmaCalibration(): Promise<SigmaCalibration> {
  const result = await db.execute(sql`
    WITH graded AS (
      SELECT DISTINCT ON (s.event_ticker, s.lead_days)
        s.metric,
        s.lead_days,
        s.forecast_value,
        st.actual_value
      FROM prediction_snapshots s
      JOIN settlements st ON st.market_ticker = s.market_ticker
      WHERE st.actual_value IS NOT NULL
        AND s.forecast_value IS NOT NULL
        AND s.lead_days IS NOT NULL
        AND s.section = 'weather'
      ORDER BY s.event_ticker, s.lead_days, s.captured_at DESC
    )
    SELECT
      metric,
      CASE
        WHEN lead_days <= 0 THEN '0'
        WHEN lead_days = 1 THEN '1'
        WHEN lead_days = 2 THEN '2'
        WHEN lead_days <= 4 THEN '3-4'
        WHEN lead_days <= 7 THEN '5-7'
        ELSE '8+'
      END AS bucket,
      stddev_samp(actual_value - forecast_value) AS sigma,
      count(*)::int AS n
    FROM graded
    GROUP BY 1, 2
  `);

  const calibration: SigmaCalibration = {};
  for (const row of result.rows as {
    metric: string;
    bucket: string;
    sigma: string | number | null;
    n: number;
  }[]) {
    const sigma = row.sigma === null ? NaN : Number(row.sigma);
    if (!Number.isFinite(sigma)) continue;
    calibration[row.metric] = calibration[row.metric] || {};
    calibration[row.metric][row.bucket] = { sigma, n: row.n };
  }

  await db
    .insert(syncMeta)
    .values({ key: META_KEY, value: calibration })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: calibration, updatedAt: new Date() },
    });

  cache = { data: calibration, ts: Date.now() };
  console.log(
    `[calibration] recomputed sigma calibration (${Object.keys(calibration).length} metrics)`,
  );
  return calibration;
}

/**
 * Load the current calibration table (cached in memory for 10 minutes).
 * Returns null until a calibration has been computed and stored.
 */
export async function getSigmaCalibration(): Promise<SigmaCalibration | null> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  try {
    const row = await db
      .select()
      .from(syncMeta)
      .where(eq(syncMeta.key, META_KEY))
      .limit(1);

    const data =
      row.length > 0 && row[0].value && Object.keys(row[0].value as object).length > 0
        ? (row[0].value as SigmaCalibration)
        : null;
    cache = { data, ts: now };
    return data;
  } catch (err) {
    console.error("[calibration] failed to load calibration:", err);
    cache = { data: null, ts: now };
    return null;
  }
}
