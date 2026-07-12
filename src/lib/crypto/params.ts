/**
 * Tunable parameters of the crypto pricing model.
 *
 * Everything here is what the backtest harness grid-searches
 * (scripts/backtest). DEFAULT_CRYPTO_PARAMS holds the values chosen on the
 * validation split — see docs/backtest-report.md for the run that picked
 * them. Production code reads these; the backtest passes overrides.
 */

/** Time-to-settlement buckets (crypto analog of weather's lead-day buckets). */
export type TauBucket = "0-15m" | "15-60m" | "1-4h" | "4-24h" | "24h+";

export function tauBucket(tauHours: number): TauBucket {
  if (tauHours <= 0.25) return "0-15m";
  if (tauHours <= 1) return "15-60m";
  if (tauHours <= 4) return "1-4h";
  if (tauHours <= 24) return "4-24h";
  return "24h+";
}

export const TAU_BUCKETS: TauBucket[] = ["0-15m", "15-60m", "1-4h", "4-24h", "24h+"];

/** Realized-vol windows (minutes) the estimator computes. */
export interface RealizedVols {
  rv30m: number | null;
  rv2h: number | null;
  rv8h: number | null;
  rv24h: number | null;
}

export type HorizonWeights = Record<
  TauBucket,
  { rv30m: number; rv2h: number; rv8h: number; rv24h: number }
>;

export interface CryptoModelParams {
  /** "rms": plain root-mean-square of 1m log returns. "ewma": exponentially weighted. */
  volMode: "rms" | "ewma";
  /** Half-life (minutes) for ewma mode. */
  ewmaHalfLifeMin: number;
  /** How much each realized-vol window contributes per τ bucket. */
  horizonWeights: HorizonWeights;
  /** Weight on Deribit implied vol (0 = realized only). */
  ivBlendBeta: number;
  /** Global σ multiplier applied before per-bucket calibration. */
  volMultiplier: number;
  /** Spot-backed flag: only within this many minutes of settlement. */
  spotBackedMaxTauMin: number;
  /** Spot-backed flag: |z| of spot vs strike must exceed this. */
  spotBackedMinZ: number;
}

/**
 * Defaults tuned by the backtest harness (see docs/backtest-report.md).
 * Short-horizon buckets lean on short realized-vol windows; long horizons
 * lean on the 24h window and implied vol.
 */
export const DEFAULT_CRYPTO_PARAMS: CryptoModelParams = {
  volMode: "ewma",
  ewmaHalfLifeMin: 120,
  horizonWeights: {
    "0-15m": { rv30m: 0.55, rv2h: 0.3, rv8h: 0.1, rv24h: 0.05 },
    "15-60m": { rv30m: 0.35, rv2h: 0.4, rv8h: 0.15, rv24h: 0.1 },
    "1-4h": { rv30m: 0.1, rv2h: 0.4, rv8h: 0.3, rv24h: 0.2 },
    "4-24h": { rv30m: 0, rv2h: 0.15, rv8h: 0.45, rv24h: 0.4 },
    "24h+": { rv30m: 0, rv2h: 0, rv8h: 0.3, rv24h: 0.7 },
  },
  ivBlendBeta: 0.4,
  volMultiplier: 1.0,
  spotBackedMaxTauMin: 30,
  spotBackedMinZ: 2,
};

/** Per-τ-bucket σ correction learned from our own settlements. */
export type CryptoVolCalibration = Partial<Record<TauBucket, { m: number; n: number }>>;

/** Minimum settled samples before a bucket's multiplier overrides 1.0. */
export const CRYPTO_CALIBRATION_MIN_SAMPLES = 30;
