import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { syncMeta } from "@/db/schema";
import { CryptoVolCalibration } from "@/lib/crypto/params";

/**
 * Per-τ-bucket σ correction learned from the crypto section's own
 * settlements — the crypto analog of calibrationStore.ts.
 *
 * For each snapshot of a settled event, the standardized outcome is
 * z = ln(actual / forecast_value) / sigma, where sigma is the snapshot's
 * log-space σ√τ. If the model's σ is right, z ~ N(0,1), so the RMS of z per
 * bucket is the multiplicative correction m the pricer should apply
 * (m > 1 ⇒ we underestimate vol at that horizon). One sample per
 * (event, bucket): bracket strikes share the same spot/σ, and repeated
 * snapshots within one bucket would multiply near-identical samples.
 */

const META_KEY = "crypto_vol_calibration";
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { data: CryptoVolCalibration | null; ts: number } | null = null;

export async function recomputeCryptoVolCalibration(): Promise<CryptoVolCalibration> {
  const result = await db.execute(sql`
    WITH bucketed AS (
      SELECT
        s.event_ticker,
        s.forecast_value,
        s.sigma,
        s.captured_at,
        st.actual_value,
        CASE
          WHEN s.tau_hours <= 0.25 THEN '0-15m'
          WHEN s.tau_hours <= 1 THEN '15-60m'
          WHEN s.tau_hours <= 4 THEN '1-4h'
          WHEN s.tau_hours <= 24 THEN '4-24h'
          ELSE '24h+'
        END AS bucket
      FROM prediction_snapshots s
      JOIN settlements st ON st.market_ticker = s.market_ticker
      WHERE s.section = 'crypto'
        AND st.actual_value IS NOT NULL AND st.actual_value > 0
        AND s.forecast_value IS NOT NULL AND s.forecast_value > 0
        AND s.sigma IS NOT NULL AND s.sigma > 0
        AND s.tau_hours IS NOT NULL AND s.tau_hours > 0
    ),
    samples AS (
      SELECT DISTINCT ON (event_ticker, bucket)
        bucket,
        ln(actual_value / forecast_value) / sigma AS z
      FROM bucketed
      ORDER BY event_ticker, bucket, captured_at DESC
    )
    SELECT bucket, sqrt(avg(z * z)) AS m, count(*)::int AS n
    FROM samples
    GROUP BY bucket
  `);

  const calibration: CryptoVolCalibration = {};
  for (const row of result.rows as { bucket: string; m: string | number | null; n: number }[]) {
    const m = row.m === null ? NaN : Number(row.m);
    if (!Number.isFinite(m) || m <= 0) continue;
    calibration[row.bucket as keyof CryptoVolCalibration] = { m, n: row.n };
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
    `[crypto/calibration] recomputed vol calibration (${Object.keys(calibration).length} buckets)`,
  );
  return calibration;
}

/** Current calibration table (10-min memory cache); null until first compute. */
export async function getCryptoVolCalibration(): Promise<CryptoVolCalibration | null> {
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
        ? (row[0].value as CryptoVolCalibration)
        : null;
    cache = { data, ts: now };
    return data;
  } catch (err) {
    console.error("[crypto/calibration] failed to load calibration:", err);
    cache = { data: null, ts: now };
    return null;
  }
}
