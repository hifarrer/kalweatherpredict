import { KalshiEvent, KalshiMarket, KalshiSeries } from "@/types";

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";

// --- In-memory caches ---
let weatherSeriesCache: { tickers: Set<string>; ts: number } | null = null;
const SERIES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all series and filter to weather-related ones.
 * Cached for 5 minutes.
 */
export async function getWeatherSeriesTickers(): Promise<Set<string>> {
  const now = Date.now();
  if (weatherSeriesCache && now - weatherSeriesCache.ts < SERIES_CACHE_TTL) {
    return weatherSeriesCache.tickers;
  }

  const tickers = new Set<string>();
  let cursor = "";

  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);

    const url = `${KALSHI_BASE}/series${params.size ? "?" + params.toString() : ""}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Kalshi /series returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const series: KalshiSeries[] = data.series || [];

    for (const s of series) {
      if (isWeatherSeries(s)) {
        tickers.add(s.ticker);
      }
    }

    cursor = data.cursor || "";
    if (!cursor) break;
    // Small delay to avoid Kalshi rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  weatherSeriesCache = { tickers, ts: now };
  return tickers;
}

function isWeatherSeries(s: KalshiSeries): boolean {
  const category = (s.category || "").toLowerCase();
  const title = (s.title || "").toLowerCase();
  const tags = (s.tags || []).map((t) => t.toLowerCase());

  // Category-based match
  if (category === "weather" || category === "climate") return true;

  // Title/tag-based match for weather keywords
  const weatherKeywords = [
    "temperature",
    "high temp",
    "low temp",
    "snowfall",
    "rainfall",
    "precipitation",
    "weather",
    "snow",
    "rain",
    "degree",
    "degrees",
  ];
  if (weatherKeywords.some((kw) => title.includes(kw) || tags.some((t) => t.includes(kw)))) {
    return true;
  }

  return false;
}

/**
 * Fetch all open weather events with nested markets.
 */
export async function getWeatherEvents(): Promise<KalshiEvent[]> {
  const weatherTickers = await getWeatherSeriesTickers();
  const nowTs = Math.floor(Date.now() / 1000);

  const events: KalshiEvent[] = [];
  let cursor = "";

  while (true) {
    const params = new URLSearchParams();
    params.set("status", "open");
    params.set("with_nested_markets", "true");
    params.set("min_close_ts", String(nowTs));
    params.set("limit", "200");
    if (cursor) params.set("cursor", cursor);

    const url = `${KALSHI_BASE}/events?${params.toString()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Kalshi /events returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const pageEvents: KalshiEvent[] = data.events || [];

    for (const e of pageEvents) {
      if (weatherTickers.has(e.series_ticker) && isWeatherEvent(e)) {
        events.push(e);
      }
    }

    cursor = data.cursor || "";
    if (!cursor) break;
    // Small delay to avoid Kalshi rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  return events;
}

/**
 * Get a single event by ticker (with nested markets).
 */
export async function getEvent(eventTicker: string): Promise<KalshiEvent | null> {
  const params = new URLSearchParams();
  params.set("with_nested_markets", "true");
  const url = `${KALSHI_BASE}/events/${encodeURIComponent(eventTicker)}?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return data.event || null;
}

// --- Sorting helpers ---

export function computeEventVolume(markets: KalshiMarket[] | undefined): number {
  if (!markets) return 0;
  return markets.reduce((sum, m) => sum + parseFloat(m.volume_fp || "0"), 0);
}

export function computeEventVolume24h(markets: KalshiMarket[] | undefined): number {
  if (!markets) return 0;
  return markets.reduce((sum, m) => sum + parseFloat(m.volume_24h_fp || "0"), 0);
}

export function computeEarliestClose(markets: KalshiMarket[] | undefined): string {
  if (!markets || markets.length === 0) return "";
  return markets
    .map((m) => m.close_time)
    .filter(Boolean)
    .sort()[0];
}

export type SortMode = "trending" | "volume" | "expiration" | "opportunity" | "edge";

/**
 * Extra safety filter: verify the event title looks weather-related.
 * Prevents false positives from series that are loosely categorized.
 */
function isWeatherEvent(e: KalshiEvent): boolean {
  const title = (e.title || "").toLowerCase();
  const subTitle = (e.sub_title || "").toLowerCase();
  const combined = `${title} ${subTitle}`;

  const weatherTerms = [
    "temperature",
    "high temp",
    "low temp",
    "rain",
    "snow",
    "snowfall",
    "precipitation",
    "degree",
    "weather",
    "wind",
    "humidity",
    "dew point",
  ];

  return weatherTerms.some((term) => combined.includes(term));
}
