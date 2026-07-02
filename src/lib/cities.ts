import { CityInfo } from "@/types";

// Map of cities commonly referenced in Kalshi weather markets.
// At least 15 US cities + a few international for coverage.
export const CITIES: CityInfo[] = [
  {
    code: "NYC",
    label: "New York City",
    lat: 40.7128,
    lon: -74.006,
    keywords: ["new york", "nyc", "central park", "manhattan", "la guardia", "laguardia", "jfk", "newark"],
  },
  {
    code: "CHI",
    label: "Chicago",
    lat: 41.8781,
    lon: -87.6298,
    keywords: ["chicago", "o'hare", "ohare", "midway"],
  },
  {
    code: "LAX",
    label: "Los Angeles",
    lat: 34.0522,
    lon: -118.2437,
    keywords: ["los angeles", "la ", "lax", "hollywood", "burbank"],
  },
  {
    code: "MIA",
    label: "Miami",
    lat: 25.7617,
    lon: -80.1918,
    keywords: ["miami", "miami-dade", "homestead"],
  },
  {
    code: "HOU",
    label: "Houston",
    lat: 29.7604,
    lon: -95.3698,
    keywords: ["houston", "bush", "iah", "hobby"],
  },
  {
    code: "PHX",
    label: "Phoenix",
    lat: 33.4484,
    lon: -112.074,
    keywords: ["phoenix", "sky harbor"],
  },
  {
    code: "DAL",
    label: "Dallas",
    lat: 32.7767,
    lon: -96.797,
    keywords: ["dallas", "dfw", "fort worth", "love field"],
  },
  {
    code: "ATL",
    label: "Atlanta",
    lat: 33.749,
    lon: -84.388,
    keywords: ["atlanta", "hartsfield"],
  },
  {
    code: "DEN",
    label: "Denver",
    lat: 39.7392,
    lon: -104.9903,
    keywords: ["denver", "stapleton", "dia"],
  },
  {
    code: "SEA",
    label: "Seattle",
    lat: 47.6062,
    lon: -122.3321,
    keywords: ["seattle", "seatac", "sea-tac", "boeing field"],
  },
  {
    code: "BOS",
    label: "Boston",
    lat: 42.3601,
    lon: -71.0589,
    keywords: ["boston", "logans", "logan international"],
  },
  {
    code: "PHL",
    label: "Philadelphia",
    lat: 39.9526,
    lon: -75.1652,
    keywords: ["philadelphia", "philly", "phl"],
  },
  {
    code: "DC",
    label: "Washington DC",
    lat: 38.9072,
    lon: -77.0369,
    keywords: ["washington dc", "washington d.c.", "dca", "reagan", "dulles", "baltimore", "bwi"],
  },
  {
    code: "SFO",
    label: "San Francisco",
    lat: 37.7749,
    lon: -122.4194,
    keywords: ["san francisco", "sfo", "bay area", "oakland", "sfo "],
  },
  {
    code: "LAS",
    label: "Las Vegas",
    lat: 36.1699,
    lon: -115.1398,
    keywords: ["las vegas", "vegas", "mccarran", "harry reid"],
  },
  {
    code: "MSP",
    label: "Minneapolis",
    lat: 44.9778,
    lon: -93.265,
    keywords: ["minneapolis", "twin cities", "st. paul", "saint paul", "msp"],
  },
  {
    code: "DTW",
    label: "Detroit",
    lat: 42.3314,
    lon: -83.0458,
    keywords: ["detroit", "dtw", "wayne county"],
  },
  {
    code: "LON",
    label: "London",
    lat: 51.5074,
    lon: -0.1278,
    keywords: ["london", "heathrow"],
  },
  {
    code: "TYO",
    label: "Tokyo",
    lat: 35.6762,
    lon: 139.6503,
    keywords: ["tokyo", "narita", "haneda"],
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
