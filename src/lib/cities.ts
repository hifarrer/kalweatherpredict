import { CityInfo, KalshiEvent } from "@/types";

// Map of cities commonly referenced in Kalshi weather markets.
// At least 15 US cities + a few international for coverage.
export const CITIES: CityInfo[] = [
  {
    code: "NYC",
    label: "New York City",
    lat: 40.7128,
    lon: -74.006,
    keywords: ["new york", "nyc", "central park", "manhattan", "la guardia", "laguardia", "jfk", "newark"],
    timezone: "America/New_York",
  },
  {
    code: "CHI",
    label: "Chicago",
    lat: 41.8781,
    lon: -87.6298,
    keywords: ["chicago", "o'hare", "ohare", "midway"],
    timezone: "America/Chicago",
  },
  {
    code: "LAX",
    label: "Los Angeles",
    lat: 34.0522,
    lon: -118.2437,
    keywords: ["los angeles", "la ", "lax", "hollywood", "burbank"],
    timezone: "America/Los_Angeles",
  },
  {
    code: "MIA",
    label: "Miami",
    lat: 25.7617,
    lon: -80.1918,
    keywords: ["miami", "miami-dade", "homestead"],
    timezone: "America/New_York",
  },
  {
    code: "HOU",
    label: "Houston",
    lat: 29.7604,
    lon: -95.3698,
    keywords: ["houston", "bush", "iah", "hobby"],
    timezone: "America/Chicago",
  },
  {
    code: "PHX",
    label: "Phoenix",
    lat: 33.4484,
    lon: -112.074,
    keywords: ["phoenix", "sky harbor"],
    timezone: "America/Phoenix",
  },
  {
    code: "DAL",
    label: "Dallas",
    lat: 32.7767,
    lon: -96.797,
    keywords: ["dallas", "dfw", "fort worth", "love field"],
    timezone: "America/Chicago",
  },
  {
    code: "ATL",
    label: "Atlanta",
    lat: 33.749,
    lon: -84.388,
    keywords: ["atlanta", "hartsfield"],
    timezone: "America/New_York",
  },
  {
    code: "DEN",
    label: "Denver",
    lat: 39.7392,
    lon: -104.9903,
    keywords: ["denver", "stapleton", "dia"],
    timezone: "America/Denver",
  },
  {
    code: "SEA",
    label: "Seattle",
    lat: 47.6062,
    lon: -122.3321,
    keywords: ["seattle", "seatac", "sea-tac", "boeing field"],
    timezone: "America/Los_Angeles",
  },
  {
    code: "BOS",
    label: "Boston",
    lat: 42.3601,
    lon: -71.0589,
    keywords: ["boston", "logans", "logan international"],
    timezone: "America/New_York",
  },
  {
    code: "PHL",
    label: "Philadelphia",
    lat: 39.9526,
    lon: -75.1652,
    keywords: ["philadelphia", "philly", "phl"],
    timezone: "America/New_York",
  },
  {
    code: "DC",
    label: "Washington DC",
    lat: 38.9072,
    lon: -77.0369,
    keywords: ["washington dc", "washington d.c.", "dca", "reagan", "dulles", "baltimore", "bwi"],
    timezone: "America/New_York",
  },
  {
    code: "SFO",
    label: "San Francisco",
    lat: 37.7749,
    lon: -122.4194,
    keywords: ["san francisco", "sfo", "bay area", "oakland", "sfo "],
    timezone: "America/Los_Angeles",
  },
  {
    code: "LAS",
    label: "Las Vegas",
    lat: 36.1699,
    lon: -115.1398,
    keywords: ["las vegas", "vegas", "mccarran", "harry reid"],
    timezone: "America/Los_Angeles",
  },
  {
    code: "MSP",
    label: "Minneapolis",
    lat: 44.9778,
    lon: -93.265,
    keywords: ["minneapolis", "twin cities", "st. paul", "saint paul", "msp"],
    timezone: "America/Chicago",
  },
  {
    code: "DTW",
    label: "Detroit",
    lat: 42.3314,
    lon: -83.0458,
    keywords: ["detroit", "dtw", "wayne county"],
    timezone: "America/Detroit",
  },
  {
    code: "SAT",
    label: "San Antonio",
    lat: 29.4241,
    lon: -98.4936,
    keywords: ["san antonio", "sat"],
    timezone: "America/Chicago",
  },
  {
    code: "AUS",
    label: "Austin",
    lat: 30.2672,
    lon: -97.7431,
    keywords: ["austin", "aus", "bergstrom", "austin-bergstrom"],
    timezone: "America/Chicago",
  },
  {
    code: "BNA",
    label: "Nashville",
    lat: 36.1627,
    lon: -86.7816,
    keywords: ["nashville", "bna", "music city"],
    timezone: "America/Chicago",
  },
  {
    code: "CLT",
    label: "Charlotte",
    lat: 35.2271,
    lon: -80.8431,
    keywords: ["charlotte", "clt", "charlotte douglas"],
    timezone: "America/New_York",
  },
  {
    code: "MCO",
    label: "Orlando",
    lat: 28.5383,
    lon: -81.3792,
    keywords: ["orlando", "mco"],
    timezone: "America/New_York",
  },
  {
    code: "TPA",
    label: "Tampa",
    lat: 27.9506,
    lon: -82.4572,
    keywords: ["tampa", "tpa", "tampa bay"],
    timezone: "America/New_York",
  },
  {
    code: "JAX",
    label: "Jacksonville",
    lat: 30.3322,
    lon: -81.6557,
    keywords: ["jacksonville", "jax"],
    timezone: "America/New_York",
  },
  {
    code: "MEM",
    label: "Memphis",
    lat: 35.1495,
    lon: -90.049,
    keywords: ["memphis", "mem"],
    timezone: "America/Chicago",
  },
  {
    code: "MSY",
    label: "New Orleans",
    lat: 29.9511,
    lon: -90.0715,
    keywords: ["new orleans", "msy", "nola", "louis armstrong"],
    timezone: "America/Chicago",
  },
  {
    code: "MCI",
    label: "Kansas City",
    lat: 39.0997,
    lon: -94.5786,
    keywords: ["kansas city", "mci", "kci"],
    timezone: "America/Chicago",
  },
  {
    code: "CLE",
    label: "Cleveland",
    lat: 41.4993,
    lon: -81.6944,
    keywords: ["cleveland", "cle", "hopkins"],
    timezone: "America/New_York",
  },
  {
    code: "CMH",
    label: "Columbus",
    lat: 39.9612,
    lon: -82.9988,
    keywords: ["columbus", "cmh", "port columbus"],
    timezone: "America/New_York",
  },
  {
    code: "CVG",
    label: "Cincinnati",
    lat: 39.1031,
    lon: -84.512,
    keywords: ["cincinnati", "cvg", "northern kentucky"],
    timezone: "America/New_York",
  },
  {
    code: "PIT",
    label: "Pittsburgh",
    lat: 40.4406,
    lon: -79.9959,
    keywords: ["pittsburgh", "pit"],
    timezone: "America/New_York",
  },
  {
    code: "STL",
    label: "St. Louis",
    lat: 38.627,
    lon: -90.1994,
    keywords: ["st. louis", "st louis", "saint louis", "stl", "lambert"],
    timezone: "America/Chicago",
  },
  {
    code: "MKE",
    label: "Milwaukee",
    lat: 43.0389,
    lon: -87.9065,
    keywords: ["milwaukee", "mke", "mitchell"],
    timezone: "America/Chicago",
  },
  {
    code: "SLC",
    label: "Salt Lake City",
    lat: 40.7608,
    lon: -111.891,
    keywords: ["salt lake city", "slc", "salt lake"],
    timezone: "America/Denver",
  },
  {
    code: "SMF",
    label: "Sacramento",
    lat: 38.5816,
    lon: -121.4944,
    keywords: ["sacramento", "smf"],
    timezone: "America/Los_Angeles",
  },
  {
    code: "SAN",
    label: "San Diego",
    lat: 32.7157,
    lon: -117.1611,
    keywords: ["san diego", "lindbergh"],
    timezone: "America/Los_Angeles",
  },
  {
    code: "TUS",
    label: "Tucson",
    lat: 32.2226,
    lon: -110.9747,
    keywords: ["tucson", "tus"],
    timezone: "America/Phoenix",
  },
  {
    code: "ELP",
    label: "El Paso",
    lat: 31.7619,
    lon: -106.485,
    keywords: ["el paso", "elp"],
    timezone: "America/Denver",
  },
  {
    code: "RDU",
    label: "Raleigh",
    lat: 35.7796,
    lon: -78.6382,
    keywords: ["raleigh", "rdu", "raleigh-durham", "durham"],
    timezone: "America/New_York",
  },
  {
    code: "IND",
    label: "Indianapolis",
    lat: 39.7684,
    lon: -86.1581,
    keywords: ["indianapolis", "ind", "indy"],
    timezone: "America/New_York",
  },
  {
    code: "LON",
    label: "London",
    lat: 51.5074,
    lon: -0.1278,
    keywords: ["london", "heathrow"],
    timezone: "Europe/London",
  },
  {
    code: "TYO",
    label: "Tokyo",
    lat: 35.6762,
    lon: 139.6503,
    keywords: ["tokyo", "narita", "haneda"],
    timezone: "Asia/Tokyo",
  },
];

export const CITY_MAP: Record<string, CityInfo> = Object.fromEntries(
  CITIES.map((c) => [c.code, c]),
);

/**
 * Detect which city a Kalshi weather event references by scanning
 * the event title, series ticker, and market rules.
 */
export function detectCity(
  eventTitle: string,
  seriesTicker: string,
  rulesPrimary?: string,
): CityInfo | null {
  const haystack = `${eventTitle} ${seriesTicker} ${rulesPrimary ?? ""}`.toLowerCase();
  for (const city of CITIES) {
    for (const kw of city.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        return city;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multi-city event detection
// ---------------------------------------------------------------------------
//
// Some Kalshi events list multiple cities as answers, e.g.
//   "Where will the max temperature be above 85 degrees on Jul 4, 2026?"
// with one market per city (market.yes_sub_title = "Chicago", etc.).
//
// detectMultiCity scans each market's sub-titles and the event sub_title to
// find a list of city answers, returning per-market city mapping when ≥ 2
// distinct cities are referenced.

export interface MarketCityMatch {
  ticker: string;
  city: CityInfo | null;
  rawName: string;
}

export interface MultiCityInfo {
  cities: CityInfo[]; // distinct resolved cities (have lat/lon)
  unresolved: string[]; // referenced city names not in our DB
  marketCities: MarketCityMatch[]; // one entry per market
}

/**
 * Match a single name token to a CityInfo.
 * Prefers exact label/keyword match, then falls back to contains.
 */
function matchCityByName(name: string): CityInfo | null {
  const clean = name.trim().toLowerCase();
  if (!clean || clean.length < 2) return null;

  // Pass 1: exact label or exact keyword
  for (const city of CITIES) {
    if (city.label.toLowerCase() === clean) return city;
    for (const kw of city.keywords) {
      if (kw.toLowerCase() === clean) return city;
    }
  }

  // Pass 2: contains (handles "Yes - Chicago", "Chicago wins", etc.)
  for (const city of CITIES) {
    if (clean.includes(city.label.toLowerCase())) return city;
    for (const kw of city.keywords) {
      if (clean.includes(kw.toLowerCase())) return city;
    }
  }

  return null;
}

/**
 * Heuristic: does this string look like a temperature/precip range or
 * threshold rather than a city name? (e.g. "85-89°F", "> 85", "above 85")
 */
function looksLikeRangeOrThreshold(s: string): boolean {
  const lower = s.toLowerCase();
  return (
    /\d+\s*[\-\u2013]\s*\d+/.test(lower) || // 85-89, 85–89
    /[><\u2265\u2264]/.test(lower) || // > < ≥ ≤
    /(above|below|over|under|at least|at most|exactly|less than|greater than)\s+\d/.test(
      lower,
    ) ||
    /^\s*\d+(\.\d+)?\s*(°|°f|f|in|inch|")?\s*$/i.test(lower) || // bare number w/ optional unit
    /yes|no|true|false/.test(lower) // generic yes/no labels
  );
}

/**
 * Split a text blob into individual name candidates.
 * Handles commas, semicolons, newlines, bullets, and " or " separators.
 */
function splitNameList(text: string): string[] {
  return text
    .split(/[,\n;]|\s+or\s+|\u2022|\*/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 40);
}

/**
 * Parse a list of city answers from an event title or sub_title.
 * Looks for patterns like "Answers: Chicago, San Antonio, ..." or a bare
 * comma-separated list in the sub_title.
 */
function parseAnswerList(text: string): string[] {
  if (!text) return [];

  // "Answers: X, Y, Z" or "Answer: X, Y"
  const answersMatch = text.match(/answers?\s*[:\-]\s*(.+)/i);
  if (answersMatch) {
    return splitNameList(answersMatch[1]);
  }

  return [];
}

/**
 * Detect whether a Kalshi event is a multi-city event (one market per city).
 *
 * Strategy: scan each market's yes_sub_title / no_sub_title for a city name,
 * and also parse the event sub_title for an explicit answers list.
 * Returns MultiCityInfo when ≥ 2 distinct cities are referenced, else null.
 */
export function detectMultiCity(event: KalshiEvent): MultiCityInfo | null {
  if (!event.markets || event.markets.length < 2) return null;

  const marketCities: MarketCityMatch[] = [];
  const cityByCode = new Map<string, CityInfo>();
  const unresolvedNames = new Set<string>();

  // --- Per-market matching (primary path) ---
  for (const m of event.markets) {
    const candidates = [m.yes_sub_title, m.no_sub_title, m.rules_primary].filter(
      Boolean,
    ) as string[];

    let matchedCity: CityInfo | null = null;
    let rawName = "";

    for (const candidate of candidates) {
      const city = matchCityByName(candidate);
      if (city) {
        matchedCity = city;
        rawName = candidate.trim();
        break;
      }
    }

    if (matchedCity) {
      cityByCode.set(matchedCity.code, matchedCity);
      marketCities.push({ ticker: m.ticker, city: matchedCity, rawName });
    } else {
      // Record the unresolved name only if it doesn't look like a range/threshold
      const name = (m.yes_sub_title || m.no_sub_title || "").trim();
      if (name && !looksLikeRangeOrThreshold(name)) {
        unresolvedNames.add(name);
      }
      marketCities.push({ ticker: m.ticker, city: null, rawName: name });
    }
  }

  // --- Parse answers list from sub_title / title (supplementary) ---
  const answersText = `${event.sub_title || ""} ${event.title || ""}`;
  const answers = parseAnswerList(answersText);
  for (const ans of answers) {
    const city = matchCityByName(ans);
    if (city) {
      cityByCode.set(city.code, city);
    } else if (!looksLikeRangeOrThreshold(ans)) {
      unresolvedNames.add(ans);
    }
  }

  const cities = [...cityByCode.values()];
  const totalDistinct = cities.length + unresolvedNames.size;

  // Only treat as multi-city when ≥ 2 distinct cities are referenced
  if (totalDistinct < 2) return null;

  return {
    cities,
    unresolved: [...unresolvedNames],
    marketCities,
  };
}

/**
 * Convenience: is this event a multi-city event?
 */
export function isMultiCityEvent(event: KalshiEvent): boolean {
  return detectMultiCity(event) !== null;
}
