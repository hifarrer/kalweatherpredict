// Kalshi API types (subset of fields we use)

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  yes_sub_title: string;
  no_sub_title: string;
  close_time: string;
  latest_expiration_time: string;
  status: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  volume_fp: string;
  volume_24h_fp: string;
  open_interest_fp: string;
  notional_value_dollars: string;
  result: string;
  rules_primary: string;
  rules_secondary: string;
  floor_strike: number | null;
  cap_strike: number | null;
  strike_type: string;
  expiration_value: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title: string;
  category: string;
  strike_date: string | null;
  markets?: KalshiMarket[];
}

export interface KalshiSeries {
  ticker: string;
  title: string;
  category: string;
  frequency: string;
  tags: string[];
  volume_fp?: string;
}

// Weather types

/**
 * The NWS climate station a city's Kalshi markets settle on.
 * Kalshi weather markets resolve from the official NWS daily climate report
 * for a specific station (named in each market's rules_primary), which can
 * sit several miles — and several °F — away from the city center.
 */
export interface StationInfo {
  id: string; // ICAO/NWS identifier, e.g. "KNYC"
  name: string;
  lat: number;
  lon: number;
  aliases: string[]; // lowercase phrases used in Kalshi rules text
}

export interface CityInfo {
  code: string;
  label: string;
  lat: number;
  lon: number;
  keywords: string[];
  timezone: string; // IANA timezone identifier, e.g. "America/Chicago"
  station?: StationInfo; // settlement station; forecasts use these coords when set
}

/**
 * Per-model point forecasts for one day (values may be null when a model's
 * horizon has been exceeded, e.g. HRRR beyond ~48h).
 */
export interface ModelDailyValues {
  max: number | null;
  min: number | null;
  precip: number | null;
  snow: number | null;
}

export interface DailyForecast {
  date: string;
  max: number;           // ensemble median (rounded)
  min: number;           // ensemble median (rounded)
  rain?: number;         // daily rain total (inches)
  precip?: number;       // daily precipitation total (inches)
  snowfall?: number;     // daily snowfall total (inches)
  precipProb?: number;   // daily max precipitation probability (%)
  byModel?: Record<string, ModelDailyValues>; // per-model values (ensemble members only)
  spread?: { max: number; min: number; precip: number; snow: number }; // cross-model stddev
}

/**
 * The kind of weather metric a prediction market is about.
 */
export type WeatherMetric =
  | "temperature_high"
  | "temperature_low"
  | "precipitation"
  | "snowfall"
  | "unknown";

export interface WeatherForecast {
  city: string;
  todayHigh: number | null;
  todayLow: number | null;
  daily: DailyForecast[];
  hourlyTimes: string[];  // local ISO, past 24h + next 72h
  hourlyTemps: number[];
  hourlyPrecip?: number[];
  // Hours already elapsed (local time <= now) — feeds same-day blending
  pastHours?: { times: string[]; temps: number[]; precip: number[] };
  // Official NWS observations for today at the settlement station (°F).
  // Authoritative over model-assimilated pastHours when present.
  stationObs?: { max: number | null; min: number | null; count: number };
  modelsUsed?: string[];
  stationId?: string;     // NWS settlement station the coords point at
  utcOffsetSeconds?: number;
}

// Prediction result

export type PredictionVerdict = "YES" | "NO" | "UNCERTAIN";

/**
 * Per-market probability estimate derived from the forecast.
 * probability is 0-1, representing P(market resolves YES).
 */
export interface MarketLikelihood {
  ticker: string;
  probability: number; // 0-1, forecast-implied P(YES)
  forecastValue?: number; // multi-city: that city's metric value
  cityCode?: string; // multi-city: the resolved city
  marketProb?: number; // 0-1, Kalshi market-implied P(YES)
  edge?: number; // probability - marketProb (positive = market underprices YES)
  decided?: boolean; // irreversibly locked by same-day observations
  obsBacked?: boolean; // probability blends today's official station observations
}

/** How strongly the forecast models agree for the target day. */
export type ModelAgreement = "high" | "medium" | "low";

export interface PredictionResult {
  verdict: PredictionVerdict;
  forecastValue: number | null;
  matchedMarket: KalshiMarket | null;
  detail: string;
  metric: WeatherMetric;
  unit: string;
  coverage?: number; // fraction of month covered by forecast (0-1) for monthly events
  marketLikelihoods?: MarketLikelihood[]; // probability for every market
  matchedCount?: number; // multi-city: number of cities forecast to satisfy the threshold
  multiCity?: boolean; // multi-city: flag for UI rendering
  targetDate?: string; // YYYY-MM-DD local date the prediction is for
  leadDays?: number; // days between now and the target date (0 = today)
  sigma?: number; // stddev used for probability estimation
  modelSpread?: number; // cross-model stddev for the target day
  agreement?: ModelAgreement; // model consensus classification
  alreadyDecided?: boolean; // same-day observations have locked the outcome
  observedSoFar?: number; // same-day running value (max temp / precip total)
}

// Enriched event (event + city + forecast + prediction)

export interface EnrichedEvent {
  event: KalshiEvent;
  cityCode: string | null;
  volume: number;
  volume24h: number;
  earliestClose: string;
  prediction: PredictionResult | null;
  opportunityScore?: number;
  subcategory: WeatherMetric;
  maxEdge?: number; // largest |forecast - market| probability gap among liquid markets
}

// AI analysis result

export interface AiAnalysisResult {
  recommendedAnswer: string;
  confidence: "High" | "Medium" | "Low";
  reasoning: string;
  factors: string[];
}

// API response shapes

export interface EventsApiResponse {
  events: EnrichedEvent[];
}

export interface WeatherApiResponse {
  forecasts: Record<string, WeatherForecast>;
}
