import { KalshiMarket, WeatherForecast, WeatherMetric } from "@/types";
import { normalCdf, clamp01 } from "@/lib/stats";

/**
 * Same-day observation blending.
 *
 * For markets settling today, part of the outcome is already known: the
 * running max temperature can't go back down, and rain that has fallen
 * can't un-fall. These helpers summarize the observed hours so far and
 * compute market probabilities that treat the observed portion as fact
 * and only the remaining hours as uncertain.
 *
 * Note: Open-Meteo past hours are model-assimilated estimates, not the
 * literal NWS climate report, so the running max can lag the official
 * value by ~1°F — probabilities are pinned only at the extreme tails.
 */

export interface SameDayObservation {
  date: string; // local date the observation covers
  observedMax: number | null;
  observedMin: number | null;
  observedPrecip: number; // inches accumulated so far today
  hoursObserved: number;
  remainingFraction: number; // fraction of the day still ahead (0-1)
  remainingMax: number | null; // forecast max over today's remaining hours
  remainingMin: number | null;
  remainingPrecip: number; // forecast precip sum over remaining hours
  source: "station" | "model"; // official NWS station obs vs model-assimilated
  maxBias: number; // station-vs-model bias applied to remainingMax (°F)
  minBias: number; // station-vs-model bias applied to remainingMin (°F)
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Summarize today's already-elapsed hours (from forecast.pastHours) and the
 * forecast for the rest of the day. Returns null when no hours of today have
 * elapsed yet (e.g. right after local midnight) or the data is missing.
 */
export function summarizeToday(forecast: WeatherForecast): SameDayObservation | null {
  const today = forecast.daily[0]?.date;
  const past = forecast.pastHours;
  if (!today || !past || past.times.length === 0) return null;

  const obsTemps: number[] = [];
  let observedPrecip = 0;
  for (let i = 0; i < past.times.length; i++) {
    if (past.times[i].startsWith(today)) {
      obsTemps.push(past.temps[i]);
      observedPrecip += past.precip[i] ?? 0;
    }
  }
  if (obsTemps.length === 0) return null;

  // Remaining hours of today from the hourly forecast series
  const lastObserved = past.times[past.times.length - 1];
  const remTemps: number[] = [];
  let remainingPrecip = 0;
  forecast.hourlyTimes.forEach((t, i) => {
    if (t.startsWith(today) && t > lastObserved) {
      remTemps.push(forecast.hourlyTemps[i]);
      remainingPrecip += forecast.hourlyPrecip?.[i] ?? 0;
    }
  });

  // Official NWS station observations are authoritative over the model's
  // assimilated hours — Kalshi settles on the station's climate report, and
  // on extreme days the model grid can run several °F away from it.
  const stationObs = forecast.stationObs;
  const useStation = !!stationObs && stationObs.count > 0;

  const modelMax = Math.max(...obsTemps);
  const modelMin = Math.min(...obsTemps);
  const observedMax = useStation && stationObs.max !== null ? stationObs.max : modelMax;
  const observedMin = useStation && stationObs.min !== null ? stationObs.min : modelMin;

  // The remaining-hours forecast comes from the same (possibly biased) model
  // grid. When the station shows the model running hot/cold today, shift the
  // remaining forecast by the observed gap (clamped to ±10°F for safety).
  const clampBias = (b: number) => Math.max(-10, Math.min(10, b));
  const maxBias = useStation && stationObs.max !== null ? clampBias(stationObs.max - modelMax) : 0;
  const minBias = useStation && stationObs.min !== null ? clampBias(stationObs.min - modelMin) : 0;

  let remainingMax = remTemps.length > 0 ? Math.max(...remTemps) : null;
  let remainingMin = remTemps.length > 0 ? Math.min(...remTemps) : null;
  if (remainingMax !== null) remainingMax = round2(remainingMax + maxBias);
  if (remainingMin !== null) remainingMin = round2(remainingMin + minBias);

  return {
    date: today,
    observedMax,
    observedMin,
    observedPrecip: round2(observedPrecip),
    hoursObserved: obsTemps.length,
    remainingFraction: remTemps.length / 24,
    remainingMax,
    remainingMin,
    remainingPrecip: round2(remainingPrecip),
    source: useStation ? "station" : "model",
    maxBias,
    minBias,
  };
}

/**
 * Outcome forced by the observed portion of the day alone, ignoring the
 * remaining-hours forecast: the running low only falls, the running high only
 * rises, and accumulated precip only grows. Returns "yes"/"no" when the
 * observations have irreversibly locked that answer, else null.
 *
 * This is deliberately stricter than "probability pinned to 0/1" — a
 * probability driven to an extreme by the *remaining-hours forecast* is a
 * model opinion, not a settled fact, and must not be flagged as decided.
 */
export function observationForcedOutcome(
  obs: SameDayObservation,
  market: KalshiMarket,
  metric: WeatherMetric,
): "yes" | "no" | null {
  const floor = market.floor_strike;
  const cap = market.cap_strike;
  // Station readings are near-exact; model-assimilated estimates can run
  // several °F off the settlement station, so demand a wide margin.
  const tol = obs.source === "station" ? 0.5 : 3;

  if (metric === "temperature_low" && obs.observedMin !== null) {
    const o = obs.observedMin;
    // Final low ≤ running low: strikes needing the low to stay ABOVE a level
    // the day has already dipped below are dead; "low ≤ cap" is locked once
    // the running low is at/below the cap. Nothing can lock "low ≥ floor".
    switch (market.strike_type) {
      case "greater":
      case "greater_or_equal":
      case "between":
        if (floor !== null && o < floor - tol) return "no";
        return null;
      case "less":
      case "less_or_equal":
        if (cap !== null && o <= cap - tol) return "yes";
        return null;
    }
    return null;
  }

  if (metric === "temperature_high" && obs.observedMax !== null) {
    const o = obs.observedMax;
    // Final high ≥ running high (mirror of the low case).
    switch (market.strike_type) {
      case "greater":
      case "greater_or_equal":
        if (floor !== null && o >= floor + tol) return "yes";
        return null;
      case "less":
      case "less_or_equal":
      case "between":
        if (cap !== null && o > cap + tol) return "no";
        return null;
    }
    return null;
  }

  if (metric === "precipitation") {
    const o = obs.observedPrecip;
    switch (market.strike_type) {
      case "greater":
      case "greater_or_equal":
        if (floor !== null && o >= floor) return "yes";
        return null;
      case "less":
      case "less_or_equal":
      case "between":
        if (cap !== null && o > cap) return "no";
        return null;
    }
    return null;
  }

  return null;
}

/**
 * P(market resolves YES) for a same-day market, blending observations with
 * the remaining-hours forecast. Returns null when the metric/strike isn't
 * supported so the caller can fall back to the plain forecast model.
 *
 * Model: the final value X is a deterministic function of the observed
 * running value and a normally-distributed remaining-hours outcome:
 *   high:   X = max(observedMax, R),  R ~ N(remainingMax, sigmaRem)
 *   low:    X = min(observedMin, R),  R ~ N(remainingMin, sigmaRem)
 *   precip: X = observed + R,         R ~ N(remainingPrecip, sigmaRem), X >= observed
 * where sigmaRem shrinks as the day runs out.
 */
export function sameDayMarketProbability(
  obs: SameDayObservation,
  market: KalshiMarket,
  metric: WeatherMetric,
  sigma: number,
): { prob: number; decided: boolean } | null {
  // The station-vs-model bias shift applied to the remaining hours is itself
  // uncertain — a model that ran 5°F off this morning may not stay 5°F off
  // tonight — so a large applied bias widens the remaining-hours uncertainty.
  const appliedBias =
    metric === "temperature_high" ? obs.maxBias :
    metric === "temperature_low" ? obs.minBias :
    0;
  const sigmaRem = Math.max(
    metric === "precipitation" ? 0.05 : 0.8,
    sigma * Math.sqrt(Math.max(0, obs.remainingFraction)),
    0.6 * Math.abs(appliedBias),
  );

  // Uncertainty of the observed running value: near-zero when it comes from
  // the official settlement station, substantial for model-assimilated
  // estimates (which can run several °F off the station on extreme days).
  const TEMP_OBS_SIGMA = obs.source === "station" ? 0.3 : 1.5;

  let cdfX: ((v: number) => number) | null = null;

  if (metric === "temperature_high" && obs.observedMax !== null) {
    // X = max(O, R): O ~ N(observedMax, obsSigma), R ~ N(remainingMax, sigmaRem)
    // P(X <= v) = P(O <= v) * P(R <= v)
    const observedMax = obs.observedMax;
    const remainingMax = obs.remainingMax;
    cdfX = (v: number) => {
      const pObsBelow = normalCdf(v, observedMax, TEMP_OBS_SIGMA);
      const pRemBelow = remainingMax === null ? 1 : normalCdf(v, remainingMax, sigmaRem);
      return pObsBelow * pRemBelow;
    };
  } else if (metric === "temperature_low" && obs.observedMin !== null) {
    // X = min(O, R): P(X <= v) = 1 - P(O > v) * P(R > v)
    const observedMin = obs.observedMin;
    const remainingMin = obs.remainingMin;
    cdfX = (v: number) => {
      const pObsAbove = 1 - normalCdf(v, observedMin, TEMP_OBS_SIGMA);
      const pRemAbove =
        remainingMin === null ? 1 : 1 - normalCdf(v, remainingMin, sigmaRem);
      return 1 - pObsAbove * pRemAbove;
    };
  } else if (metric === "precipitation") {
    // Total = observed + remaining; observed itself carries ~15% gauge error
    const observed = obs.observedPrecip;
    const mu = observed + obs.remainingPrecip;
    const sigmaObs = Math.max(0.02, 0.15 * observed);
    const sigmaTotal = Math.sqrt(sigmaObs ** 2 + sigmaRem ** 2);
    cdfX = (v: number) => {
      if (v < 0) return 0;
      return normalCdf(v, mu, sigmaTotal);
    };
  }

  if (!cdfX) return null;
  const prob = strikeProbFromCdf(cdfX, market);
  if (prob === null) return null;

  // "Decided" only when the probability is pinned AND the observed portion of
  // the day alone locks the answer — extreme probabilities that rest on the
  // remaining-hours forecast stay undecided (the forecast can be wrong).
  const forced = observationForcedOutcome(obs, market, metric);
  const decided =
    (prob >= 0.999 && forced === "yes") || (prob <= 0.001 && forced === "no");
  return { prob, decided };
}

function strikeProbFromCdf(
  cdf: (v: number) => number,
  market: KalshiMarket,
): number | null {
  const floor = market.floor_strike;
  const cap = market.cap_strike;
  let prob: number;

  switch (market.strike_type) {
    case "greater":
    case "greater_or_equal":
      if (floor === null) return null;
      prob = 1 - cdf(floor);
      break;
    case "less":
    case "less_or_equal":
      if (cap === null) return null;
      prob = cdf(cap);
      break;
    case "between":
      if (floor === null || cap === null) return null;
      prob = cdf(cap) - cdf(floor);
      break;
    default:
      return null;
  }

  return clamp01(prob);
}
