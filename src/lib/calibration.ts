/**
 * Sigma calibration types + bucket logic (client-safe).
 *
 * The DB-backed load/recompute lives in calibrationStore.ts (server-only) so
 * that the predictor — which client components import for pure helpers —
 * doesn't drag the Postgres driver into browser bundles.
 */

export interface SigmaCalibrationBucket {
  sigma: number;
  n: number; // sample count backing this estimate
}

/** metric -> lead bucket ("0", "1", "2", "3-4", "5-7", "8+") -> estimate */
export type SigmaCalibration = Record<string, Record<string, SigmaCalibrationBucket>>;

/** Minimum samples before a calibrated bucket overrides the base table. */
export const CALIBRATION_MIN_SAMPLES = 30;

export const LEAD_BUCKETS = ["0", "1", "2", "3-4", "5-7", "8+"] as const;

export function leadBucket(leadDays: number): string {
  if (leadDays <= 0) return "0";
  if (leadDays === 1) return "1";
  if (leadDays === 2) return "2";
  if (leadDays <= 4) return "3-4";
  if (leadDays <= 7) return "5-7";
  return "8+";
}
