import { Candle } from "@/lib/crypto/spot";
import { CryptoAssetInfo } from "@/lib/crypto/assets";
import {
  CRYPTO_CALIBRATION_MIN_SAMPLES,
  CryptoModelParams,
  CryptoVolCalibration,
  DEFAULT_CRYPTO_PARAMS,
  RealizedVols,
  tauBucket,
} from "@/lib/crypto/params";

/**
 * Volatility engine: annualized realized vol from 1m candles over several
 * windows, Deribit DVOL implied vol, and the final σ blend the pricer uses.
 * All functions except getImpliedVol are pure so the backtest can replay
 * them over historical candles.
 */

const MINUTES_PER_YEAR = 365 * 24 * 60;
export const HOURS_PER_YEAR = 365 * 24;

const RV_WINDOWS_MIN: { key: keyof RealizedVols; minutes: number }[] = [
  { key: "rv30m", minutes: 30 },
  { key: "rv2h", minutes: 120 },
  { key: "rv8h", minutes: 480 },
  { key: "rv24h", minutes: 1440 },
];

/** Minimum returns in a window before we trust its estimate. */
const MIN_RETURNS_PER_WINDOW = 10;

/**
 * Annualized realized vol per window from 1m candles.
 *
 * Each squared log return is normalized by its actual time span, so gaps in
 * the candle series widen the denominator instead of biasing σ upward:
 * variance/year = Σr² / Σdt. In "ewma" mode returns are weighted by
 * 2^(−age/halfLife), emphasizing the newest prints.
 */
export function computeRealizedVols(
  candles: Candle[],
  nowMs: number,
  params: CryptoModelParams = DEFAULT_CRYPTO_PARAMS,
): RealizedVols {
  const out: RealizedVols = { rv30m: null, rv2h: null, rv8h: null, rv24h: null };
  if (candles.length < 2) return out;

  const sorted = [...candles].sort((a, b) => a.ts - b.ts);

  for (const { key, minutes } of RV_WINDOWS_MIN) {
    const cutoff = nowMs - minutes * 60 * 1000;
    const inWindow = sorted.filter((c) => c.ts >= cutoff && c.close > 0);
    if (inWindow.length < MIN_RETURNS_PER_WINDOW + 1) continue;

    let sumR2 = 0;
    let sumDtYears = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const dtMin = (inWindow[i].ts - inWindow[i - 1].ts) / 60000;
      if (dtMin <= 0 || dtMin > 60) continue; // clock issues / huge gaps
      const r = Math.log(inWindow[i].close / inWindow[i - 1].close);
      const w =
        params.volMode === "ewma"
          ? Math.pow(2, -((nowMs - inWindow[i].ts) / 60000) / params.ewmaHalfLifeMin)
          : 1;
      sumR2 += w * r * r;
      sumDtYears += (w * dtMin) / MINUTES_PER_YEAR;
    }
    if (sumDtYears <= 0) continue;
    out[key] = Math.sqrt(sumR2 / sumDtYears);
  }

  return out;
}

/**
 * Blend the realized-vol windows into one annualized σ for a horizon.
 * Missing windows redistribute their weight over the available ones.
 */
export function blendHorizonVol(
  rvs: RealizedVols,
  tauHours: number,
  params: CryptoModelParams = DEFAULT_CRYPTO_PARAMS,
): number | null {
  const weights = params.horizonWeights[tauBucket(tauHours)];
  let sum = 0;
  let wSum = 0;
  for (const { key } of RV_WINDOWS_MIN) {
    const v = rvs[key];
    const w = weights[key];
    if (v === null || !Number.isFinite(v) || w <= 0) continue;
    sum += w * v;
    wSum += w;
  }
  if (wSum <= 0) return null;
  return sum / wSum;
}

// --- Deribit DVOL (implied vol) ---------------------------------------------

const DERIBIT_BASE = "https://www.deribit.com/api/v2/public";
const IV_TTL_MS = 5 * 60 * 1000;
const ivCache = new Map<string, { iv: number | null; ts: number }>();

/**
 * Latest DVOL reading as an annualized fraction (e.g. 0.36 for 36%).
 * Cached 5 minutes; returns null on any failure so the realized-vol path
 * never blocks on Deribit.
 */
export async function getImpliedVol(asset: CryptoAssetInfo): Promise<number | null> {
  const cached = ivCache.get(asset.code);
  if (cached && Date.now() - cached.ts < IV_TTL_MS) return cached.iv;

  let iv: number | null = null;
  try {
    const end = Date.now();
    const start = end - 3 * 60 * 60 * 1000;
    const params = new URLSearchParams({
      currency: asset.deribitCurrency,
      resolution: "3600",
      start_timestamp: String(start),
      end_timestamp: String(end),
    });
    const res = await fetch(`${DERIBIT_BASE}/get_volatility_index_data?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        result?: { data?: [number, number, number, number, number][] };
      };
      const rows = data.result?.data ?? [];
      const lastClose = rows.length > 0 ? rows[rows.length - 1][4] : null;
      if (lastClose !== null && Number.isFinite(lastClose) && lastClose > 0) {
        iv = lastClose / 100; // DVOL is quoted in percent
      }
    }
  } catch (err) {
    console.warn(`[crypto/vol] Deribit DVOL fetch failed for ${asset.code}:`, err);
  }

  ivCache.set(asset.code, { iv, ts: Date.now() });
  return iv;
}

// --- Final σ -----------------------------------------------------------------

export interface SigmaParts {
  realized: number | null;
  implied: number | null;
  blended: number;
  calibrationMult: number;
  sigmaAnnual: number;
}

/**
 * The σ the pricer uses: realized/implied blend × global multiplier ×
 * per-bucket calibration multiplier (only once a bucket has enough settled
 * samples). Returns null when no vol estimate exists at all.
 */
export function finalSigma(
  rvs: RealizedVols,
  implied: number | null,
  tauHours: number,
  calibration: CryptoVolCalibration | null,
  params: CryptoModelParams = DEFAULT_CRYPTO_PARAMS,
): SigmaParts | null {
  const realized = blendHorizonVol(rvs, tauHours, params);

  let blended: number;
  if (realized !== null && implied !== null) {
    blended = (1 - params.ivBlendBeta) * realized + params.ivBlendBeta * implied;
  } else if (realized !== null) {
    blended = realized;
  } else if (implied !== null) {
    blended = implied;
  } else {
    return null;
  }

  const bucket = tauBucket(tauHours);
  const cal = calibration?.[bucket];
  const calibrationMult =
    cal && cal.n >= CRYPTO_CALIBRATION_MIN_SAMPLES && Number.isFinite(cal.m) && cal.m > 0
      ? cal.m
      : 1;

  const sigmaAnnual = blended * params.volMultiplier * calibrationMult;
  return { realized, implied, blended, calibrationMult, sigmaAnnual };
}
