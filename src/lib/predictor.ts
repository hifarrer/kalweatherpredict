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
import {
  SigmaCalibration,
  leadBucket,
  CALIBRATION_MIN_SAMPLES,
} from "@/lib/calibration";
import { ModelAgreement } from "@/types";
import { summarizeToday, sameDayMarketProbability, SameDayObservation } from "@/lib/observed";
import { normalCdf } from "@/lib/stats";

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
 * 2. Event's strike_date, converted from UTC to the city's local timezone.
 * 3. Market close_time, converted from UTC to the city's local timezone.
 * 4. Fallback: today.
 */
export function getRelevantForecastIndex(
  forecast: WeatherForecast,
  event: KalshiEvent,
  market: KalshiMarket,
  timezone?: string,
): number {
  return getTargetDay(forecast, event, market, timezone).index;
}

/**
 * Sentinel index for events whose target date is outside the forecast window
 * (most commonly yesterday's still-open markets after local midnight). No
 * forecast day is correct for them, so callers must skip prediction entirely.
 */
export const STALE_EVENT_INDEX = -1;

/**
 * Resolve the forecast day an event targets, along with its date and lead
 * time. daily[0] is today in the city's local timezone, so leadDays === index.
 * index is STALE_EVENT_INDEX (with date null) when the event's date falls
 * outside the forecast window — callers must not predict such events.
 */
export function getTargetDay(
  forecast: WeatherForecast,
  event: KalshiEvent,
  market: KalshiMarket,
  timezone?: string,
): { index: number; date: string | null; leadDays: number } {
  const index = resolveForecastIndex(forecast, event, market, timezone);
  return {
    index,
    date: forecast.daily[index]?.date ?? null,
    leadDays: index,
  };
}

function resolveForecastIndex(
  forecast: WeatherForecast,
  event: KalshiEvent,
  market: KalshiMarket,
  timezone?: string,
): number {
  if (forecast.daily.length === 0) return STALE_EVENT_INDEX;

  const candidates: string[] = [];

  // 1. Parse date from the event title (e.g. "on Jul 1, 2026")
  const titleDate = parseDateFromTitle(event.title);
  if (titleDate) {
    candidates.push(titleDate);
  }

  // 2. Event's strike_date (convert UTC to local timezone to avoid off-by-one)
  if (event.strike_date) {
    const localDate = utcToLocalDateString(event.strike_date, timezone);
    if (localDate) candidates.push(localDate);
  }

  // The event's OWN date (title/strike) is authoritative. If it falls outside
  // the forecast window — e.g. yesterday's still-open event after local
  // midnight, when daily[0] has rolled to the new day — no forecast day is
  // right, so refuse to predict. The close_time candidate must never rescue
  // such an event: weather markets close AFTER their target day (12:59 AM
  // next local day), so it lands on the wrong date by construction, and the
  // old index-0 fallback silently scored yesterday's event against today's
  // forecast and observations (99.7% of target-date-mismatched graded
  // suggestions lost).
  const today = forecast.daily[0].date;
  const hasOwnDate = candidates.length > 0;
  if (hasOwnDate && candidates.every((c) => c < today)) {
    return STALE_EVENT_INDEX;
  }

  // 3. Market close_time (convert to local timezone date)
  if (market.close_time) {
    const localDate = utcToLocalDateString(market.close_time, timezone);
    if (localDate) candidates.push(localDate);
  }

  // Try each candidate against the forecast daily array
  for (const candidate of candidates) {
    const idx = forecast.daily.findIndex((d) => d.date === candidate);
    if (idx >= 0) return idx;
  }

  // An event dated (by title/strike) outside the forecast window is
  // unpredictable; only genuinely undated events fall back to today.
  return hasOwnDate ? STALE_EVENT_INDEX : 0;
}

/**
 * Parse a date string from an event title like "on Jul 1, 2026" or "on July 1".
 * Returns YYYY-MM-DD format, or null if not found.
 */
export function parseDateFromTitle(title: string): string | null {
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
 * Convert a UTC ISO timestamp to a local date string (YYYY-MM-DD)
 * using the given IANA timezone.
 *
 * This correctly handles DST and per-city timezone offsets, unlike the
 * old hardcoded 6-hour shift. For example, a Kalshi close_time of
 * "2026-07-03T05:59:00Z" represents 12:59 AM CDT on July 3, which is
 * the settlement window after an 11:59 PM ET last-trade on July 2.
 *
 * Falls back to a 6-hour shift if no timezone is provided (legacy behavior).
 */
export function utcToLocalDateString(
  utcIso: string,
  timezone?: string,
): string | null {
  try {
    const dt = new Date(utcIso);
    if (timezone) {
      // Use Intl.DateTimeFormat to get the calendar date in the target tz.
      // The en-CA locale produces YYYY-MM-DD which is what we need.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(dt);
    }
    // Legacy fallback: approximate US timezones with a 6-hour shift
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

  // Hourly-settlement temperature series (KXTEMPNYCH etc., "NYC temperature
  // on Jul 9 at 10am EDT?") settle on the reading AT one hour, not the daily
  // extreme. The daily high/low pipeline fundamentally misprices them (it
  // claimed up to 99.99% on markets the book priced at 6¢ and went 0-for-12
  // live), so classify them as unknown — predictEvent then skips them.
  if (
    /^KXTEMP[A-Z]*H$/.test(event.series_ticker || "") ||
    /\btemperature on .{3,20} at \d{1,2}\s?[ap]m\b/.test(haystack)
  ) {
    return "unknown";
  }

  // Check precipitation first (most specific)
  if (/\brain\b|rainfall|precipitation|inches of rain/.test(haystack)) {
    return "precipitation";
  }

  // Check snowfall
  if (/\bsnow\b|snowfall|inches of snow/.test(haystack)) {
    return "snowfall";
  }

  // Check low temperature ("low/lowest/minimum temperature", "overnight low")
  if (/low(est)?\s+temp|min(imum)?\s+temp|overnight low/.test(haystack)) {
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

/**
 * Market-implied probability of YES: prefer the last traded price, fall
 * back to the YES bid. Shared by the UI badges, edge computation, and
 * prediction snapshots so all use the same formula.
 */
export function impliedMarketProb(m: KalshiMarket): number {
  const lastPrice = parseFloat(m.last_price_dollars || "0");
  if (lastPrice > 0) return lastPrice;
  const yesBid = parseFloat(m.yes_bid_dollars || "0");
  return yesBid > 0 ? yesBid : 0;
}

// ---------------------------------------------------------------------------
// Per-market probability estimation (for gradient highlighting)
// ---------------------------------------------------------------------------

/**
 * Legacy fixed forecast uncertainty per metric. Still used for monthly
 * projections (scaled up) where the lead-time model doesn't apply.
 */
function legacyStdDev(metric: WeatherMetric): number {
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
 * Base forecast error growth with lead time, per metric family.
 * Tuned to typical NWS/model verification stats; replaced by empirically
 * calibrated values once enough settlement history accumulates.
 */
const SIGMA_BASE: Record<string, { intercept: number; perDay: number; cap: number; floor: number }> = {
  temperature: { intercept: 1.8, perDay: 0.37, cap: 6.0, floor: 1.0 },
  precipitation: { intercept: 0.3, perDay: 0.12, cap: 1.2, floor: 0.1 },
  snowfall: { intercept: 0.8, perDay: 0.25, cap: 3.0, floor: 0.3 },
};

function sigmaParams(metric: WeatherMetric) {
  if (metric === "precipitation") return SIGMA_BASE.precipitation;
  if (metric === "snowfall") return SIGMA_BASE.snowfall;
  return SIGMA_BASE.temperature;
}

/**
 * Forecast uncertainty (stddev) for a prediction:
 * - grows with lead time (a 10-day forecast deserves wider error bars),
 * - never narrower than the cross-model disagreement for that day,
 * - uses the empirically calibrated value when enough samples exist.
 */
export function computeSigma(
  metric: WeatherMetric,
  leadDays: number,
  modelSpread = 0,
  calibration?: SigmaCalibration | null,
): number {
  const p = sigmaParams(metric);
  const lead = Math.max(0, leadDays);

  const cal = calibration?.[metric]?.[leadBucket(lead)];
  if (cal && cal.n >= CALIBRATION_MIN_SAMPLES) {
    return Math.max(p.floor, cal.sigma, 0.75 * modelSpread);
  }

  const base = Math.min(p.cap, p.intercept + p.perDay * lead);
  return Math.max(p.floor, base, modelSpread);
}

/**
 * Pick the cross-model spread relevant to a metric for one forecast day,
 * and count how many ensemble members actually cover that day.
 */
export function spreadForMetric(
  daily: DailyForecast,
  metric: WeatherMetric,
): { spread: number; models: number } {
  const key =
    metric === "temperature_low" ? "min" :
    metric === "precipitation" ? "precip" :
    metric === "snowfall" ? "snow" :
    "max";

  const spread = daily.spread?.[key] ?? 0;

  let models = 0;
  if (daily.byModel) {
    for (const mv of Object.values(daily.byModel)) {
      const v =
        key === "min" ? mv.min :
        key === "precip" ? mv.precip :
        key === "snow" ? mv.snow :
        mv.max;
      if (v !== null && v !== undefined) models++;
    }
  }

  return { spread, models };
}

/**
 * Classify how much the forecast models agree for a day/metric.
 * With fewer than 2 covering models there is no consensus signal — treat
 * as low so the UI doesn't paint false confidence.
 */
export function classifyAgreement(
  metric: WeatherMetric,
  spread: number,
  models: number,
): ModelAgreement {
  if (models < 2) return "low";
  const [high, medium] =
    metric === "precipitation" ? [0.15, 0.4] :
    metric === "snowfall" ? [0.5, 1.5] :
    [1.5, 3.0];
  if (spread <= high) return "high";
  if (spread <= medium) return "medium";
  return "low";
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
  sigmaOverride?: number,
): number {
  const sigma = sigmaOverride ?? computeSigma(metric, 0);
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

// --- Same-day hard tail clamp ----------------------------------------------

/** Margin (°F) beyond the running value before a strike is deemed unreachable. */
const SAME_DAY_CLAMP_MARGIN = 3;
/** Probability ceiling for unreachable same-day strikes. */
const SAME_DAY_CLAMP_PROB = 0.02;

/**
 * Cap the probability of same-day temperature strikes the day has already put
 * out of reach: today's running low only goes down and running high only goes
 * up, so e.g. "low ≥ 84" with a forecast low of 79 is effectively impossible.
 * Only applied when hourly observation blending is UNAVAILABLE — the plain
 * Normal model's tails would otherwise keep such strikes alive. With
 * observations, the blending model is authoritative (a strike above the
 * running low may genuinely still be in play on a hot day).
 */
export function sameDayTailClampProb(
  probability: number,
  market: KalshiMarket,
  metric: WeatherMetric,
  forecastValue: number,
): number {
  if (metric !== "temperature_low" && metric !== "temperature_high") return probability;

  const floor = market.floor_strike;
  const cap = market.cap_strike;
  let unreachable = false;

  if (metric === "temperature_low") {
    // Strikes requiring the day's low to end up well ABOVE the current
    // forecast/observed low can no longer happen.
    switch (market.strike_type) {
      case "greater":
      case "greater_or_equal":
      case "between":
        unreachable = floor !== null && floor >= forecastValue + SAME_DAY_CLAMP_MARGIN;
        break;
    }
  } else {
    // temperature_high: strikes requiring the day's high to stay well BELOW
    // the current forecast/observed high can no longer happen.
    switch (market.strike_type) {
      case "less":
      case "less_or_equal":
      case "between":
        unreachable = cap !== null && cap <= forecastValue - SAME_DAY_CLAMP_MARGIN;
        break;
    }
  }

  return unreachable ? Math.min(probability, SAME_DAY_CLAMP_PROB) : probability;
}

/** Apply sameDayTailClampProb across an event's likelihoods, fixing edges. */
function applySameDayTailClamp(
  likelihoods: MarketLikelihood[],
  markets: KalshiMarket[],
  metric: WeatherMetric,
  forecastValue: number,
): void {
  const byTicker = new Map(markets.map((m) => [m.ticker, m]));
  for (const ml of likelihoods) {
    const m = byTicker.get(ml.ticker);
    if (!m) continue;
    const clamped = sameDayTailClampProb(ml.probability, m, metric, forecastValue);
    if (clamped !== ml.probability) {
      ml.probability = clamped;
      if (ml.marketProb != null) ml.edge = clamped - ml.marketProb;
    }
  }
}

export function computeMarketLikelihoods(
  forecastValue: number,
  markets: KalshiMarket[],
  metric: WeatherMetric,
  sigma?: number,
): MarketLikelihood[] {
  return markets.map((m) => {
    const probability = computeMarketProbability(forecastValue, m, metric, sigma);
    const marketProb = impliedMarketProb(m);
    return {
      ticker: m.ticker,
      probability,
      marketProb,
      edge: probability - marketProb,
    };
  });
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
  timezone?: string,
  calibration?: SigmaCalibration | null,
): PredictionResult | null {
  if (!forecast || !event.markets || event.markets.length === 0) return null;

  const primary = getPrimaryMarket(event.markets);
  if (!primary) return null;

  // Detect the weather metric type for this event
  const metric = detectMetric(event);
  if (metric === "unknown") return null; // e.g. hourly temp series — no model for these
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
    // Monthly totals extrapolate from partial coverage — the lead-time model
    // doesn't apply, so use a doubled fixed sigma to reflect the extra noise.
    const monthlySigma = legacyStdDev(metric) * 2;
    const marketLikelihoods = computeMarketLikelihoods(
      forecastValue,
      event.markets,
      metric,
      monthlySigma,
    );

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
        sigma: monthlySigma,
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
      sigma: monthlySigma,
    };
  }

  // Single-day events (temperature or daily precipitation)
  const target = getTargetDay(forecast, event, primary, timezone);
  const daily = forecast.daily[target.index];
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

  // Uncertainty: lead-time base widened by cross-model disagreement
  const { spread, models } = spreadForMetric(daily, metric);
  const sigma = computeSigma(metric, target.leadDays, spread, calibration);
  const agreement = classifyAgreement(metric, spread, models);

  // Same-day markets: blend what has already been observed with the
  // remaining-hours forecast. A running max above a strike decides it.
  const obs =
    target.leadDays === 0 && metric !== "snowfall" ? summarizeToday(forecast) : null;

  let marketLikelihoods: MarketLikelihood[];
  let observedSoFar: number | undefined;

  if (obs) {
    if (metric === "temperature_high" && obs.observedMax !== null) {
      observedSoFar = obs.observedMax;
      forecastValue = Math.max(forecastValue, obs.observedMax);
    } else if (metric === "temperature_low" && obs.observedMin !== null) {
      observedSoFar = obs.observedMin;
      forecastValue = Math.min(forecastValue, obs.observedMin);
    } else if (metric === "precipitation") {
      observedSoFar = obs.observedPrecip;
    }

    marketLikelihoods = event.markets.map((m) => {
      const marketProb = impliedMarketProb(m);
      const blended = sameDayMarketProbability(obs, m, metric, sigma);
      const probability =
        blended?.prob ?? computeMarketProbability(forecastValue, m, metric, sigma);
      return {
        ticker: m.ticker,
        probability,
        marketProb,
        edge: probability - marketProb,
        decided: blended?.decided || undefined,
        obsBacked: (blended && obs.source === "station") || undefined,
      };
    });
  } else {
    marketLikelihoods = computeMarketLikelihoods(forecastValue, event.markets, metric, sigma);

    // No observations for a same-day market: the plain Normal model's tails
    // would keep already-out-of-reach strikes alive, so clamp them near zero.
    // (With observations, the blending model handles this correctly — a strike
    // above the running low may genuinely still be in play.)
    if (target.leadDays === 0) {
      applySameDayTailClamp(marketLikelihoods, event.markets, metric, forecastValue);
    }
  }

  const decidedByTicker = new Map(
    marketLikelihoods.map((ml) => [ml.ticker, ml.decided === true]),
  );

  const meta = {
    targetDate: target.date ?? daily.date,
    leadDays: target.leadDays,
    sigma,
    modelSpread: spread,
    agreement,
    observedSoFar,
  };

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
      ...meta,
      alreadyDecided: decidedByTicker.get(matchedBucket.ticker) || undefined,
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
    ...meta,
    alreadyDecided: decidedByTicker.get(primary.ticker) || undefined,
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
  calibration?: SigmaCalibration | null,
): PredictionResult | null {
  if (!event.markets || event.markets.length === 0) return null;

  const metric = detectMetric(event);
  if (metric === "unknown") return null;
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
      // Unresolved city — no forecast, so no opinion. Emitting probability 0
      // here would tell the scorer "NO is certain" from missing data.
      continue;
    }

    totalResolved++;

    // Find the relevant forecast day for this city (using city's timezone)
    const target = getTargetDay(forecast, event, m, mc.city?.timezone);
    const daily = forecast.daily[target.index];
    if (!daily) {
      // Stale event (target date outside the forecast window) or missing
      // forecast day — skip rather than claim certainty from missing data.
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

    const { spread } = spreadForMetric(daily, metric);
    const sigma = computeSigma(metric, target.leadDays, spread, calibration);

    // Same-day markets: blend this city's observed hours with the forecast
    let blended: { prob: number; decided: boolean } | null = null;
    if (target.leadDays === 0 && metric !== "snowfall") {
      const obs: SameDayObservation | null = summarizeToday(forecast);
      if (obs) {
        blended = sameDayMarketProbability(obs, m, metric, sigma);
        if (metric === "temperature_high" && obs.observedMax !== null) {
          forecastValue = Math.max(forecastValue, obs.observedMax);
        } else if (metric === "temperature_low" && obs.observedMin !== null) {
          forecastValue = Math.min(forecastValue, obs.observedMin);
        }
      }
    }

    let prob = blended?.prob ?? computeMarketProbability(forecastValue, m, metric, sigma);
    // Clamp unreachable strikes only when observation blending didn't run —
    // with observations the blended model already treats the running value as fact.
    if (target.leadDays === 0 && !blended) {
      prob = sameDayTailClampProb(prob, m, metric, forecastValue);
    }
    const marketProb = impliedMarketProb(m);
    marketLikelihoods.push({
      ticker: m.ticker,
      probability: prob,
      forecastValue,
      cityCode,
      marketProb,
      edge: prob - marketProb,
      decided: blended?.decided || undefined,
      obsBacked: (blended && forecast.stationObs && forecast.stationObs.count > 0) || undefined,
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
