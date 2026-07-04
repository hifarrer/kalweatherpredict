import { KalshiMarket, WeatherMetric } from "@/types";

/** Human-readable strike label, e.g. "> 85°F" or "83-84°F". */
export function formatStrike(m: KalshiMarket, subcategory: WeatherMetric): string {
  if (!m.strike_type) return "";
  const unit =
    subcategory === "precipitation" || subcategory === "snowfall" ? "in" : "°F";
  switch (m.strike_type) {
    case "greater":
    case "greater_or_equal":
      return m.floor_strike !== null ? `> ${m.floor_strike}${unit}` : "";
    case "less":
    case "less_or_equal":
      return m.cap_strike !== null ? `< ${m.cap_strike}${unit}` : "";
    case "between":
      if (m.floor_strike !== null && m.cap_strike !== null) {
        return `${m.floor_strike}-${m.cap_strike}${unit}`;
      }
      return "";
    default:
      return "";
  }
}

export function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return String(Math.round(vol));
}

/** Dollars-string ("0.37") to a cents label ("37¢"); em dash when absent/zero. */
export function formatCents(dollars: string | undefined): string {
  const v = parseFloat(dollars || "0");
  if (!v) return "—";
  return `${Math.round(v * 100)}¢`;
}
