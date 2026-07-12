import { describe, expect, it } from "vitest";
import { blendHorizonVol, computeRealizedVols, finalSigma } from "@/lib/crypto/vol";
import { Candle } from "@/lib/crypto/spot";
import {
  CRYPTO_CALIBRATION_MIN_SAMPLES,
  DEFAULT_CRYPTO_PARAMS,
  CryptoModelParams,
  tauBucket,
} from "@/lib/crypto/params";

const MINUTES_PER_YEAR = 365 * 24 * 60;

// Pin multiplier/beta so these tests isolate the estimator math from the
// backtest-tuned production defaults.
const RMS_PARAMS: CryptoModelParams = {
  ...DEFAULT_CRYPTO_PARAMS,
  volMode: "rms",
  volMultiplier: 1,
  ivBlendBeta: 0.4,
};

/**
 * Synthetic candle series with constant per-minute log return magnitude r,
 * alternating sign so the price stays flat. Realized vol should recover
 * σ = r·√(minutes per year).
 */
function syntheticCandles(nowMs: number, minutes: number, r: number): Candle[] {
  const candles: Candle[] = [];
  let price = 50_000;
  for (let i = minutes; i >= 1; i--) {
    price = price * Math.exp(i % 2 === 0 ? r : -r);
    candles.push({
      ts: nowMs - i * 60_000,
      open: price,
      high: price,
      low: price,
      close: price,
    });
  }
  return candles;
}

describe("computeRealizedVols", () => {
  it("recovers the true vol from a constant-|return| series (rms mode)", () => {
    const now = Date.now();
    const r = 0.0005; // 5 bps per minute
    const candles = syntheticCandles(now, 1440, r);
    const rvs = computeRealizedVols(candles, now, RMS_PARAMS);
    const expected = r * Math.sqrt(MINUTES_PER_YEAR); // ≈ 0.3626
    for (const key of ["rv30m", "rv2h", "rv8h", "rv24h"] as const) {
      expect(rvs[key]).not.toBeNull();
      expect(rvs[key]!).toBeCloseTo(expected, 2);
    }
  });

  it("weights recent returns more in ewma mode", () => {
    const now = Date.now();
    // Calm for 23h, then violent for the last hour
    const calm = syntheticCandles(now - 60 * 60_000, 1380, 0.0001);
    const wild = syntheticCandles(now, 60, 0.002);
    const candles = [...calm, ...wild];
    const rms = computeRealizedVols(candles, now, RMS_PARAMS).rv24h!;
    const ewma = computeRealizedVols(candles, now, {
      ...DEFAULT_CRYPTO_PARAMS,
      volMode: "ewma",
      ewmaHalfLifeMin: 60,
    }).rv24h!;
    expect(ewma).toBeGreaterThan(rms);
  });

  it("returns nulls when there is too little data", () => {
    const rvs = computeRealizedVols([], Date.now(), RMS_PARAMS);
    expect(rvs.rv30m).toBeNull();
    expect(rvs.rv24h).toBeNull();
  });
});

describe("blendHorizonVol", () => {
  it("redistributes weight when windows are missing", () => {
    const blended = blendHorizonVol(
      { rv30m: null, rv2h: null, rv8h: 0.4, rv24h: 0.4 },
      0.5, // 15-60m bucket, whose weight leans on the missing short windows
      DEFAULT_CRYPTO_PARAMS,
    );
    expect(blended).toBeCloseTo(0.4, 10);
  });

  it("returns null when no windows are available", () => {
    expect(
      blendHorizonVol({ rv30m: null, rv2h: null, rv8h: null, rv24h: null }, 1),
    ).toBeNull();
  });
});

describe("tauBucket", () => {
  it("maps horizons to the documented buckets", () => {
    expect(tauBucket(0.1)).toBe("0-15m");
    expect(tauBucket(0.5)).toBe("15-60m");
    expect(tauBucket(3)).toBe("1-4h");
    expect(tauBucket(10)).toBe("4-24h");
    expect(tauBucket(48)).toBe("24h+");
  });
});

describe("finalSigma", () => {
  const rvs = { rv30m: 0.3, rv2h: 0.3, rv8h: 0.3, rv24h: 0.3 };

  it("blends realized and implied by ivBlendBeta", () => {
    const parts = finalSigma(rvs, 0.5, 1, null, {
      ...RMS_PARAMS,
      ivBlendBeta: 0.4,
      volMultiplier: 1,
    });
    expect(parts!.blended).toBeCloseTo(0.6 * 0.3 + 0.4 * 0.5, 10);
    expect(parts!.sigmaAnnual).toBeCloseTo(parts!.blended, 10);
  });

  it("falls back to realized-only when implied is unavailable", () => {
    const parts = finalSigma(rvs, null, 1, null, RMS_PARAMS);
    expect(parts!.blended).toBeCloseTo(0.3, 10);
  });

  it("applies calibration only past the sample threshold", () => {
    const starving = finalSigma(rvs, null, 0.5, {
      "15-60m": { m: 1.5, n: CRYPTO_CALIBRATION_MIN_SAMPLES - 1 },
    }, RMS_PARAMS);
    expect(starving!.calibrationMult).toBe(1);

    const fed = finalSigma(rvs, null, 0.5, {
      "15-60m": { m: 1.5, n: CRYPTO_CALIBRATION_MIN_SAMPLES },
    }, RMS_PARAMS);
    expect(fed!.calibrationMult).toBe(1.5);
    expect(fed!.sigmaAnnual).toBeCloseTo(0.45, 10);
  });

  it("returns null with no vol source at all", () => {
    expect(
      finalSigma({ rv30m: null, rv2h: null, rv8h: null, rv24h: null }, null, 1, null),
    ).toBeNull();
  });
});
