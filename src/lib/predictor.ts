import {
  DailyForecast,
  KalshiEvent,
  KalshiMarket,
  MarketLikelihood,
  PredictionResult,
  PredictionVerdict,
  WeatherForecast,
  WeatherMetric,
} from "@/types";
import { MarketCityMatch } from "@/lib/cities";

/**
 * Find the primary market in an event — the one with the highest 24h volume.
 */
export function getPrimaryMarket(markets: KalshiMarket[] | undefined): KalshiMarket | null {
  if (!markets || markets.length === 0) return null;
  return [...markets].sort(
    (a, b) => parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0"),
  )[0];
}

/**
 * Determine which day's forecast is relevant for an event.
 *
 * Priority order (first match wins):
 * 1. Date parsed from the event title (e.g. "on Jul 1, 2026") — most reliable,
 *    it's the human-readable local date the event is about.
 * 2. Event's strike_date, converted from UTC to local (avoids off-by-one).
 * 3. Market close_time, converted from UTC to local.
 * 4. Fallback: today.
 */
export function getRelevantForecastIndex(
  forecast: WeatherForecast,
  event: KalshiEvent,
  market: KalshiMarket,
): number {
  if (forecast.daily.length === 0) return 0;

  const candidates: string[] = [];

  // 1. Parse date from the event title (e.g. "on Jul 1, 2026")
  const titleDate = parseDateFromTitle(event.title);
  if (titleDate) {
    candidates.push(titleDate);
  }

  // 2. Event's strike_date (convert UTC to local to avoid off-by-one)
  if (event.strike_date) {
    const localDate = utcToLocalDateString(event.strike_date);
    if (localDate) candidates.push(localDate);
  }

  // 3. Market close_time (shift to local date using UTC offset)
  if (market.close_time) {
    const localDate = utcToLocalDateString(market.close_time);
    if (localDate) candidates.push(localDate);
  }

  // Try each candidate against the forecast daily array
  for (const candidate of candidates) {
    const idx = forecast.daily.findIndex((d) => d.date === candidate);
    if (idx >= 0) return idx;
  }

  // Fallback: today (index 0)
  return 0;
}

/**
 * Parse a date string from an event title like "on Jul 1, 2026" or "on July 1".
 * Returns YYYY-MM-DD format, or null if not found.
 */
function parseDateFromTitle(title: string): string | null {
  const match = title.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s*(\d{4})\b/i,
  );
  if (!match) return null;

  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const monthIdx = monthNames.indexOf(match[1].toLowerCase().slice(0, 3));
  if (monthIdx < 0) return null;

  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, monthIdx, day));
  return date.toISOString().split("T")[0];
}

/**
 * Convert a UTC ISO timestamp to a local date string.
 * Shifts back ~6 hours to approximate US timezones where close time
 * is typically near midnight local (e.g. 03:59 UTC = 11:59 PM EDT).
 */
function utcToLocalDateString(utcIso: string): string | null {
  try {
    const dt = new Date(utcIso);
    const local = new Date(dt.getTime() - 6 * 60 * 60 * 1000);
    return local.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

/**
 * Detect the type of weather metric a market event is about.
 */
export function detectMetric(event: KalshiEvent): WeatherMetric {
  const rules = event.markets?.[0]?.rules_primary || "";
  const haystack = `${event.title} ${event.sub_title} ${rules}`.toLowerCase();

  // Check precipitation first (most specific)
  if (/\brain\b|rainfall|precipitation|inches of rain/.test(haystack)) {
    return "precipitation";
  }

  // Check snowfall
  if (/\bsnow\b|snowfall|inches of snow/.test(haystack)) {
    return "snowfall";
  }

  // Check low temperature
  if (/low temp|low temperature|overnight low/.test(haystack)) {
    return "temperature_low";
  }

  // Default: high temperature
  return "temperature_high";
}

/**
 * Returns the display unit for a given metric.
 */
function metricUnit(metric: WeatherMetric): string {
  switch (metric) {
    case "temperature_high":
    case "temperature_low":
      return "°F";
    case "precipitation":
    case "snowfall":
      return "in";
    default:
      return "";
  }
}

/**
 * Detect a full-month range pattern like "Jul 2026" or "July 2026" without a day.
 * Returns { year, month } where month is 0-indexed, or null.
 */
export function detectMonthlyRange(
  title: string,
): { year: number; month: number } | null {
  // Must contain a month + year but NOT a specific day number
  const monthYearMatch = title.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i,
  );
  if (!monthYearMatch) return null;

  // If there's a specific day: "Month DD, YYYY" or "Month DD YYYY", it's not monthly
  const dayMatch = title.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})[,\s]/i,
  );
  if (dayMatch) return null;

  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const monthIdx = monthNames.indexOf(monthYearMatch[1].toLowerCase().slice(0, 3));
  if (monthIdx < 0) return null;

  const year = parseInt(monthYearMatch[2], 10);
  return { year, month: monthIdx };
}

/**
 * Project a monthly total for rain or snow by summing available forecast days
 * and extrapolating to the full month.
 */
export function projectMonthlyTotal(
  daily: DailyForecast[],
  metric: WeatherMetric,
  month: number,
  year: number,
): { total: number; coverage: number } | null {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;

  // Filter forecast days that fall within the target month
  const monthDays = daily.filter((d) => d.date.startsWith(monthPrefix));
  if (monthDays.length === 0) return null;

  // Sum the relevant metric across forecast days
  let partialSum = 0;
  for (const d of monthDays) {
    if (metric === "precipitation") {
      partialSum += d.rain ?? d.precip ?? 0;
    } else if (metric === "snowfall") {
      partialSum += d.snowfall ?? 0;
    }
  }

  const coverage = monthDays.length / daysInMonth;
  const projectedTotal = coverage > 0 ? partialSum / coverage : partialSum;

  return { total: round1(projectedTotal), coverage };
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function formatMonthYear(month: number, year: number): string {
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${names[month] ?? month} ${year}`;
}

/**
 * Evaluate whether the forecast value satisfies the market strike.
 */
export function evaluateStrike(
  forecastValue: number,
  market: KalshiMarket,
): PredictionVerdict {
  const floor = market.floor_strike;
  const cap = market.cap_strike;
  const strikeType = market.strike_type;

  switch (strikeType) {
    case "greater":
    case "greater_or_equal":
      if (floor === null) return "UNCERTAIN";
      return forecastValue >= floor ? "YES" : "NO";

    case "less":
    case "less_or_equal":
      if (cap === null) return "UNCERTAIN";
      return forecastValue <= cap ? "YES" : "NO";

    case "between":
      if (floor === null || cap === null) return "UNCERTAIN";
      return forecastValue >= floor && forecastValue <= cap ? "YES" : "NO";

    default:
      return "UNCERTAIN";
  }
}

/**
 * For range-bucket events (multiple markets with floor/cap ranges),
 * find the market whose [floor, cap] interval contains the forecast.
 */
export function findMatchingBucket(
  forecastValue: number,
  markets: KalshiMarket[],
): KalshiMarket | null {
  const bucketMarkets = markets.filter((m) => m.strike_type === "between");
  for (const m of bucketMarkets) {
    if (m.floor_strike !== null && m.cap_strike !== null) {
      if (forecastValue >= m.floor_strike && forecastValue <= m.cap_strike) {
        return m;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-market probability estimation (for gradient highlighting)
// ---------------------------------------------------------------------------

/**
 * Approximation of the error function (Abramowitz & Stegun 7.1.26).
 * Max error ~1.5×10⁻⁷.
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Cumulative distribution function of a normal distribution.
 * Returns P(X <= x) where X ~ N(mean, std²).
 */
function normalCdf(x: number, mean: number, std: number): number {
  return 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));
}

/**
 * Forecast uncertainty (standard deviation) per metric.
 * Represents how much the actual weather value typically deviates from
 * the forecast point estimate.
 */
function forecastStdDev(metric: WeatherMetric): number {
  switch (metric) {
    case "temperature_high":
    case "temperature_low":
      return 3; // ±3°F
    case "precipitation":
      return 0.6; // ±0.6 inches
    case "snowfall":
      return 1.5; // ±1.5 inches
    default:
      return 3;
  }
}

/**
 * Compute P(market resolves YES) for every market in an event,
 * given a forecast point estimate.
 *
 * Models the actual weather outcome as normally distributed around the
 * forecast value. Each market's strike condition is then evaluated against
 * this distribution to produce a probability.
 */
/**
 * Compute P(market resolves YES) for a single market given a forecast value.
 * Extracted from computeMarketLikelihoods so it can be reused per-city.
 */
export function computeMarketProbability(
  forecastValue: number,
  market: KalshiMarket,
  metric: WeatherMetric,
): number {
  const sigma = forecastStdDev(metric);
  const floor = market.floor_strike;
  const cap = market.cap_strike;
  let prob = 0;

  switch (market.strike_type) {
    case "greater":
    case "greater_or_equal":
      // P(X >= floor)
      prob = floor !== null ? 1 - normalCdf(floor, forecastValue, sigma) : 0;
      break;
    case "less":
    case "less_or_equal":
      // P(X <= cap)
      prob = cap !== null ? normalCdf(cap, forecastValue, sigma) : 0;
      break;
    case "between":
      // P(floor <= X <= cap)
      if (floor !== null && cap !== null) {
        prob = normalCdf(cap, forecastValue, sigma) - normalCdf(floor, forecastValue, sigma);
      }
      break;
    default:
      prob = 0;
  }

  // Clamp to [0, 1] (numerical safety)
  return Math.max(0, Math.min(1, prob));
}

export function computeMarketLikelihoods(
  forecastValue: number,
  markets: KalshiMarket[],
  metric: WeatherMetric,
): MarketLikelihood[] {
  return markets.map((m) => ({
    ticker: m.ticker,
    probability: computeMarketProbability(forecastValue, m, metric),
  }));
}

/**
 * Main prediction logic: compare the weather forecast against the event's market strikes.
 *
 * Supports temperature, precipitation (rain), and snowfall events.
 * For monthly precipitation/snowfall events, projects a monthly total from
 * available forecast data by linear extrapolation.
 */
export function predictEvent(
  event: KalshiEvent,
  forecast: WeatherForecast | null,
): PredictionResult | null {
  if (!forecast || !event.markets || event.markets.length === 0) return null;

  const primary = getPrimaryMarket(event.markets);
  if (!primary) return null;

  // Detect the weather metric type for this event
  const metric = detectMetric(event);
  const unit = metricUnit(metric);

  // Handle monthly precipitation/snowfall events
  const monthlyRange = detectMonthlyRange(event.title);
  if (monthlyRange && (metric === "precipitation" || metric === "snowfall")) {
    const projection = projectMonthlyTotal(
      forecast.daily,
      metric,
      monthlyRange.month,
      monthlyRange.year,
    );

    if (!projection || projection.coverage < 0.15) {
      const pct = projection ? `${(projection.coverage * 100).toFixed(0)}%` : "0%";
      return {
        verdict: "UNCERTAIN",
        forecastValue: null,
        matchedMarket: null,
        detail: `Insufficient forecast data for ${formatMonthYear(monthlyRange.month, monthlyRange.year)}. Forecast covers ${pct} of the month.`,
        metric,
        unit,
        coverage: projection?.coverage,
      };
    }

    const forecastValue = projection.total;
    const coveragePct = `${(projection.coverage * 100).toFixed(0)}%`;
    const marketLikelihoods = computeMarketLikelihoods(forecastValue, event.markets, metric);

    // Strategy 1: Range-bucket markets
    const matchedBucket = findMatchingBucket(forecastValue, event.markets);
    if (matchedBucket) {
      return {
        verdict: "YES",
        forecastValue,
        matchedMarket: matchedBucket,
        detail: `Projected total ${forecastValue.toFixed(1)}${unit} for ${formatMonthYear(monthlyRange.month, monthlyRange.year)} (extrapolated from ${coveragePct} coverage) falls in the ${formatRange(matchedBucket, unit)} range.`,
        metric,
        unit,
        coverage: projection.coverage,
        marketLikelihoods,
      };
    }

    // Strategy 2: Single threshold market
    const verdict = evaluateStrike(forecastValue, primary);
    const direction = describeStrike(primary, unit);

    return {
      verdict,
      forecastValue,
      matchedMarket: primary,
      detail: `Projected total ${forecastValue.toFixed(1)}${unit} for ${formatMonthYear(monthlyRange.month, monthlyRange.year)} (extrapolated from ${coveragePct} coverage) vs ${direction}.`,
      metric,
      unit,
      coverage: projection.coverage,
      marketLikelihoods,
    };
  }

  // Single-day events (temperature or daily precipitation)
  const forecastIdx = getRelevantForecastIndex(forecast, event, primary);
  const daily = forecast.daily[forecastIdx];
  if (!daily) return null;

  // Determine the relevant forecast value based on metric
  let forecastValue: number;
  switch (metric) {
    case "temperature_low":
      forecastValue = daily.min;
      break;
    case "precipitation":
      forecastValue = daily.rain ?? daily.precip ?? 0;
      break;
    case "snowfall":
      forecastValue = daily.snowfall ?? 0;
      break;
    case "temperature_high":
    default:
      forecastValue = daily.max;
      break;
  }

  const marketLikelihoods = computeMarketLikelihoods(forecastValue, event.markets, metric);

  // Strategy 1: Range-bucket markets
  const matchedBucket = findMatchingBucket(forecastValue, event.markets);
  if (matchedBucket) {
    return {
      verdict: "YES",
      forecastValue,
      matchedMarket: matchedBucket,
      detail: `Forecast ${forecastValue}${unit} on ${daily.date} falls in the ${formatRange(matchedBucket, unit)} range.`,
      metric,
      unit,
      marketLikelihoods,
    };
  }

  // Strategy 2: Single threshold market
  const verdict = evaluateStrike(forecastValue, primary);
  const direction = describeStrike(primary, unit);
  const metricLabel =
    metric === "temperature_low" ? "low" :
    metric === "precipitation" ? "rain" :
    metric === "snowfall" ? "snow" :
    "high";

  return {
    verdict,
    forecastValue,
    matchedMarket: primary,
    detail: `Forecast ${metricLabel} ${forecastValue}${unit} on ${daily.date} vs ${direction}.`,
    metric,
    unit,
    marketLikelihoods,
  };
}

// ---------------------------------------------------------------------------
// Multi-city prediction (one market per city)
// ---------------------------------------------------------------------------

/**
 * Threshold above which a city counts as "matching" the question.
 */
const MULTI_CITY_MATCH_THRESHOLD = 0.6;

/**
 * Predict a multi-city event where each market corresponds to a different city.
 *
 * Fetches the relevant-day forecast for each market's city, computes a
 * per-market probability using computeMarketProbability, and returns a
 * PredictionResult whose marketLikelihoods drives the green gradient
 * highlighting in MarketsList.
 */
export function predictMultiCityEvent(
  event: KalshiEvent,
  forecastMap: Record<string, WeatherForecast>,
  marketCities: MarketCityMatch[],
): PredictionResult | null {
  if (!event.markets || event.markets.length === 0) return null;

  const metric = detectMetric(event);
  const unit = metricUnit(metric);

  const primary = getPrimaryMarket(event.markets);
  if (!primary) return null;

  // Build a ticker -> MarketCityMatch lookup
  const matchByTicker = new Map<string, MarketCityMatch>();
  for (const mc of marketCities) {
    matchByTicker.set(mc.ticker, mc);
  }

  const marketLikelihoods: MarketLikelihood[] = [];
  const matchedNames: { label: string; value: number }[] = [];
  let totalResolved = 0;

  for (const m of event.markets) {
    const mc = matchByTicker.get(m.ticker);
    const cityCode = mc?.city?.code;
    const forecast = cityCode ? forecastMap[cityCode] : undefined;

    if (!cityCode || !forecast || !mc?.city) {
      // Unresolved city — no forecast available
      marketLikelihoods.push({
        ticker: m.ticker,
        probability: 0,
        cityCode: cityCode ?? undefined,
      });
      continue;
    }

    totalResolved++;

    // Find the relevant forecast day for this city
    const forecastIdx = getRelevantForecastIndex(forecast, event, m);
    const daily = forecast.daily[forecastIdx];
    if (!daily) {
      marketLikelihoods.push({ ticker: m.ticker, probability: 0, cityCode });
      continue;
    }

    // Read the metric value for this city/day
    let forecastValue: number;
    switch (metric) {
      case "temperature_low":
        forecastValue = daily.min;
        break;
      case "precipitation":
        forecastValue = daily.rain ?? daily.precip ?? 0;
        break;
      case "snowfall":
        forecastValue = daily.snowfall ?? 0;
        break;
      case "temperature_high":
      default:
        forecastValue = daily.max;
        break;
    }

    const prob = computeMarketProbability(forecastValue, m, metric);
    marketLikelihoods.push({
      ticker: m.ticker,
      probability: prob,
      forecastValue,
      cityCode,
    });

    if (prob >= MULTI_CITY_MATCH_THRESHOLD) {
      matchedNames.push({ label: mc.city.label, value: forecastValue });
    }
  }

  const matchedCount = matchedNames.length;
  const verdict: PredictionVerdict = matchedCount >= 1 ? "YES" : "UNCERTAIN";

  // Highest-probability market for matchedMarket
  let bestMarket: KalshiMarket | null = null;
  let bestProb = -1;
  for (const ml of marketLikelihoods) {
    if (ml.probability > bestProb) {
      bestProb = ml.probability;
      const found = event.markets.find((mk) => mk.ticker === ml.ticker);
      if (found) bestMarket = found;
    }
  }

  // Build a human-readable detail string
  const direction = describeStrike(primary, unit);
  const matchedSummary = matchedNames
    .slice(0, 5)
    .map((c) => `${c.label} ${c.value}${unit}`)
    .join(", ");

  let detail: string;
  if (matchedCount > 0) {
    const cityWord = matchedCount === 1 ? "city" : "cities";
    detail = `${matchedCount} of ${totalResolved} ${cityWord} forecast ${direction}: ${matchedSummary}`;
  } else if (totalResolved > 0) {
    const cityWord = totalResolved === 1 ? "city" : "cities";
    detail = `No cities forecast ${direction} (checked ${totalResolved} ${cityWord})`;
  } else {
    detail = "No city forecasts available for this event";
  }

  return {
    verdict,
    forecastValue: null,
    matchedMarket: bestMarket,
    detail,
    metric,
    unit,
    marketLikelihoods,
    matchedCount,
    multiCity: true,
  };
}

function formatRange(m: KalshiMarket, unit: string): string {
  return `${m.floor_strike}-${m.cap_strike}${unit}`;
}

function describeStrike(m: KalshiMarket, unit: string): string {
  const floor = m.floor_strike;
  const cap = m.cap_strike;
  switch (m.strike_type) {
    case "greater":
    case "greater_or_equal":
      return `threshold ${floor}${unit} (above)`;
    case "less":
    case "less_or_equal":
      return `threshold ${cap}${unit} (below)`;
    case "between":
      return `range ${floor}-${cap}${unit}`;
    default:
      return m.yes_sub_title || "threshold";
  }
}

/**
 * Clamp a number between min and max.
 */
function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Compute an opportunity score (0-100) for an event.
 *
 * Finds markets where the weather forecast strongly supports a YES outcome
 * but the Kalshi YES price is low — i.e. a potential value bet.
 *
 * Formula: opportunityScore = forecastConfidence × priceDiscount × 100
 * - Returns 0 if the prediction is NO/UNCERTAIN, or the market is illiquid.
 */
export function computeOpportunityScore(
  event: KalshiEvent,
  prediction: PredictionResult | null,
): number {
  if (!prediction || prediction.verdict !== "YES" || !prediction.matchedMarket) {
    return 0;
  }

  const market = prediction.matchedMarket;
  const forecastValue = prediction.forecastValue;
  if (forecastValue === null) return 0;

  // Require minimum liquidity — illiquid markets aren't real opportunities
  const vol24 = parseFloat(market.volume_24h_fp || "0");
  if (vol24 < 100) return 0;

  // Metric-aware margin thresholds
  const marginThresholds: Record<string, { bucket: number; threshold: number }> = {
    temperature_high: { bucket: 3, threshold: 5 },
    temperature_low: { bucket: 3, threshold: 5 },
    precipitation: { bucket: 0.3, threshold: 0.5 },
    snowfall: { bucket: 1.0, threshold: 2.0 },
  };
  const thresholds =
    marginThresholds[prediction.metric] || marginThresholds.temperature_high;

  // Calculate forecast confidence based on how safely inside the strike we are
  let confidence = 0;
  const floor = market.floor_strike;
  const cap = market.cap_strike;

  switch (market.strike_type) {
    case "between": {
      if (floor === null || cap === null) return 0;
      const margin = Math.min(forecastValue - floor, cap - forecastValue);
      confidence = clamp(margin / thresholds.bucket, 0.15, 1.0);
      break;
    }
    case "greater":
    case "greater_or_equal": {
      if (floor === null) return 0;
      const margin = forecastValue - floor;
      confidence = clamp(margin / thresholds.threshold, 0.15, 1.0);
      break;
    }
    case "less":
    case "less_or_equal": {
      if (cap === null) return 0;
      const margin = cap - forecastValue;
      confidence = clamp(margin / thresholds.threshold, 0.15, 1.0);
      break;
    }
    default:
      return 0;
  }

  // For monthly events, scale confidence by forecast coverage
  if (prediction.coverage !== undefined && prediction.coverage < 0.9) {
    confidence *= prediction.coverage;
  }

  // Price discount: cheaper YES = higher value
  const yesPrice = parseFloat(market.yes_bid_dollars || "0");
  const priceDiscount = 1 - yesPrice;

  // If YES is already expensive (>$0.85), not much opportunity left
  if (priceDiscount < 0.15) return 0;

  const score = Math.round(confidence * priceDiscount * 100);
  return score;
}
