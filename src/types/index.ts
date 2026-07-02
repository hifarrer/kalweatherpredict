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

export interface CityInfo {
  code: string;
  label: string;
  lat: number;
  lon: number;
  keywords: string[];
}

export interface DailyForecast {
  date: string;
  max: number;
  min: number;
  rain?: number;         // daily rain total (inches)
  precip?: number;       // daily precipitation total (inches)
  snowfall?: number;     // daily snowfall total (inches)
  precipProb?: number;   // daily max precipitation probability (%)
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
  hourlyTimes: string[];
  hourlyTemps: number[];
}

// Prediction result

export type PredictionVerdict = "YES" | "NO" | "UNCERTAIN";

/**
 * Per-market probability estimate derived from the forecast.
 * probability is 0-1, representing P(market resolves YES).
 */
export interface MarketLikelihood {
  ticker: string;
  probability: number; // 0-1
}

export interface PredictionResult {
  verdict: PredictionVerdict;
  forecastValue: number | null;
  matchedMarket: KalshiMarket | null;
  detail: string;
  metric: WeatherMetric;
  unit: string;
  coverage?: number; // fraction of month covered by forecast (0-1) for monthly events
  marketLikelihoods?: MarketLikelihood[]; // probability for every market
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
