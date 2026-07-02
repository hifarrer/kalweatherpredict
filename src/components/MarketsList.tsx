import { KalshiMarket, WeatherMetric } from "@/types";

interface MarketsListProps {
  markets: KalshiMarket[] | undefined;
  subcategory?: WeatherMetric;
}

export default function MarketsList({ markets, subcategory = "temperature_high" }: MarketsListProps) {
  if (!markets || markets.length === 0) {
    return <p className="text-xs text-kalshi-muted">No markets available</p>;
  }

  // Sort by 24h volume, take top 5
  const top = [...markets]
    .sort((a, b) => parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0"))
    .slice(0, 5);

  return (
    <div className="space-y-1">
      {top.map((m) => {
        const yesPrice = parseFloat(m.yes_bid_dollars || "0");
        const noPrice = parseFloat(m.no_bid_dollars || "0");
        const vol24 = parseFloat(m.volume_24h_fp || "0");
        const strikeLabel = formatStrike(m, subcategory);

        return (
          <div
            key={m.ticker}
            className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/5 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <span className="text-xs text-kalshi-text truncate block">
                {m.yes_sub_title || m.ticker}
              </span>
              {strikeLabel && (
                <span className="text-[10px] text-kalshi-muted">{strikeLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-kalshi-green/15 text-kalshi-green">
                  YES {Math.round(yesPrice * 100)}¢
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-kalshi-red/15 text-kalshi-red">
                  NO {Math.round(noPrice * 100)}¢
                </span>
              </div>
              <span className="text-[10px] text-kalshi-muted w-14 text-right">
                {formatVolume(vol24)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatStrike(m: KalshiMarket, subcategory: WeatherMetric): string {
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

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return String(Math.round(vol));
}
