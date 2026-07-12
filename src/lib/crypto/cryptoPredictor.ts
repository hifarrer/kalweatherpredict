import { KalshiEvent, KalshiMarket, MarketLikelihood, PredictionResult } from "@/types";
import { normalCdf, clamp01 } from "@/lib/stats";
import { impliedMarketProb, utcToLocalDateString } from "@/lib/predictor";
import { SpotInfo } from "@/lib/crypto/spot";
import { CryptoModelParams, DEFAULT_CRYPTO_PARAMS } from "@/lib/crypto/params";
import { HOURS_PER_YEAR } from "@/lib/crypto/vol";

/**
 * Log-normal diffusion pricer for Kalshi "price at time T" crypto markets.
 *
 * The price is modeled as a drift-free geometric Brownian motion around the
 * current spot: ln(S_T) ~ Normal(ln(S) − s²/2, s²) with s = σ_annual·√τ, so
 * E[S_T] = S (martingale). Strike probabilities are the log-space Normal CDF
 * over the strike condition — the same structure predictor.ts uses for
 * temperatures, but in log space and with volatility instead of forecast
 * error as the σ source.
 */

/** Kalshi crypto events settle every market at one instant. */
function eventCloseMs(event: KalshiEvent): number | null {
  const times = (event.markets ?? [])
    .map((m) => (m.close_time ? new Date(m.close_time).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return Math.min(...times);
}

/** Total log-space σ over the horizon: σ_annual · √(τ in years). */
export function logSpaceSigma(sigmaAnnual: number, tauHours: number): number {
  if (tauHours <= 0 || sigmaAnnual <= 0) return 0;
  return sigmaAnnual * Math.sqrt(tauHours / HOURS_PER_YEAR);
}

/**
 * P(market resolves YES) for one strike under the diffusion model.
 * At τ→0 (or σ→0) this degenerates to a step function on current spot.
 */
export function priceStrikeProb(
  spot: number,
  market: Pick<KalshiMarket, "strike_type" | "floor_strike" | "cap_strike">,
  sigmaAnnual: number,
  tauHours: number,
): number | null {
  if (!(spot > 0)) return null;
  const s = logSpaceSigma(sigmaAnnual, tauHours);
  const mu = Math.log(spot) - (s * s) / 2;

  // P(S_T <= k) in log space; degenerate step when s = 0
  const cdf = (k: number) => (s > 0 ? normalCdf(Math.log(k), mu, s) : spot <= k ? 1 : 0);

  const floor = market.floor_strike;
  const cap = market.cap_strike;

  switch (market.strike_type) {
    case "greater":
    case "greater_or_equal":
      return floor !== null && floor > 0 ? clamp01(1 - cdf(floor)) : null;
    case "less":
    case "less_or_equal":
      return cap !== null && cap > 0 ? clamp01(cdf(cap)) : null;
    case "between":
      if (floor !== null && cap !== null && floor > 0 && cap > floor) {
        return clamp01(cdf(cap) - cdf(floor));
      }
      return null;
    default:
      return null;
  }
}

/** Distance from spot to the market's strike center (for the consensus pick). */
function strikeCenterDistance(m: KalshiMarket, spot: number): number | null {
  switch (m.strike_type) {
    case "between":
      return m.floor_strike !== null && m.cap_strike !== null
        ? Math.abs((m.floor_strike + m.cap_strike) / 2 - spot)
        : null;
    case "greater":
    case "greater_or_equal":
      return m.floor_strike !== null ? Math.abs(m.floor_strike - spot) : null;
    case "less":
    case "less_or_equal":
      return m.cap_strike !== null ? Math.abs(m.cap_strike - spot) : null;
    default:
      return null;
  }
}

export interface CryptoPredictionContext {
  nowMs?: number;
  params?: CryptoModelParams;
  /** Extra info for the detail string. */
  sigmaSource?: string;
}

/**
 * Full PredictionResult for one crypto event, shaped so the existing
 * suggestion scorer, snapshot job, and UI components consume it unchanged.
 *
 * The spot-backed flag (stored on MarketLikelihood.obsBacked) marks markets
 * whose outcome the live spot has nearly locked shortly before settlement —
 * |z| ≥ spotBackedMinZ within spotBackedMaxTauMin of close. blendProbability
 * then skips its tail/disagreement shrinkage for them: a large gap vs the
 * market there usually means the book hasn't repriced to the spot move yet
 * (the crypto analog of weather's station-observation blending). `decided`
 * is never set — price can always still move.
 */
export function predictCryptoEvent(
  event: KalshiEvent,
  spot: SpotInfo,
  sigmaAnnual: number,
  ctx?: CryptoPredictionContext,
): PredictionResult | null {
  const params = ctx?.params ?? DEFAULT_CRYPTO_PARAMS;
  const now = ctx?.nowMs ?? Date.now();
  const markets = event.markets ?? [];
  if (markets.length === 0 || !(spot.price > 0) || !(sigmaAnnual > 0)) return null;

  const closeMs = eventCloseMs(event);
  if (closeMs === null || closeMs <= now) return null;
  const tauHours = (closeMs - now) / 3_600_000;
  const tauMin = tauHours * 60;
  const s = logSpaceSigma(sigmaAnnual, tauHours);

  const zThreshProb = normalCdf(params.spotBackedMinZ, 0, 1); // e.g. z=2 → 0.977
  const spotBackedEligible = tauMin <= params.spotBackedMaxTauMin;

  const likelihoods: MarketLikelihood[] = [];
  for (const m of markets) {
    const prob = priceStrikeProb(spot.price, m, sigmaAnnual, tauHours);
    if (prob === null) continue;
    const marketProb = impliedMarketProb(m);
    likelihoods.push({
      ticker: m.ticker,
      probability: prob,
      marketProb: marketProb > 0 ? marketProb : undefined,
      edge: marketProb > 0 ? prob - marketProb : undefined,
      obsBacked: spotBackedEligible && (prob >= zThreshProb || prob <= 1 - zThreshProb),
    });
  }
  if (likelihoods.length === 0) return null;

  // Consensus market: the strike bracket nearest current spot
  let matched: KalshiMarket | null = null;
  let bestDist = Infinity;
  for (const m of markets) {
    const d = strikeCenterDistance(m, spot.price);
    if (d !== null && d < bestDist) {
      bestDist = d;
      matched = m;
    }
  }
  const matchedProb = matched
    ? likelihoods.find((l) => l.ticker === matched!.ticker)?.probability
    : undefined;

  const tauLabel =
    tauMin < 90 ? `${Math.round(tauMin)}m` : `${(tauHours).toFixed(1)}h`;
  const detail = `Spot $${spot.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${spot.source}) · σ ${(sigmaAnnual * 100).toFixed(1)}%/yr${ctx?.sigmaSource ? ` (${ctx.sigmaSource})` : ""} · settles in ${tauLabel}`;

  return {
    verdict:
      matchedProb === undefined
        ? "UNCERTAIN"
        : matchedProb >= 0.6
          ? "YES"
          : matchedProb <= 0.4
            ? "NO"
            : "UNCERTAIN",
    forecastValue: spot.price,
    matchedMarket: matched,
    detail,
    metric: "crypto_price",
    unit: "$",
    marketLikelihoods: likelihoods,
    targetDate:
      utcToLocalDateString(new Date(closeMs).toISOString(), "America/New_York") ??
      undefined,
    // Log-space σ√τ — the calibration job's z-score denominator
    sigma: s,
    tauHours,
  };
}
