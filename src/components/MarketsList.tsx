import { KalshiMarket, MarketLikelihood, WeatherMetric } from "@/types";

interface MarketsListProps {
  markets: KalshiMarket[] | undefined;
  subcategory?: WeatherMetric;
  marketLikelihoods?: MarketLikelihood[];
}

const HIGHLIGHT_THRESHOLD = 0.08; // only highlight markets with >=8% probability

export default function MarketsList({
  markets,
  subcategory = "temperature_high",
  marketLikelihoods,
}: MarketsListProps) {
  if (!markets || markets.length === 0) {
    return <p className="text-xs text-kalshi-muted">No markets available</p>;
  }

  // Build probability lookup map
  const probMap = new Map<string, number>();
  if (marketLikelihoods) {
    for (const ml of marketLikelihoods) {
      probMap.set(ml.ticker, ml.probability);
    }
  }

  const hasLikelihoods = probMap.size > 0;

  // When we have likelihoods, sort by probability desc and show up to 7.
  // Otherwise fall back to top 5 by 24h volume.
  let top: KalshiMarket[];
  if (hasLikelihoods) {
    top = [...markets]
      .sort((a, b) => {
        const pa = probMap.get(a.ticker) ?? 0;
        const pb = probMap.get(b.ticker) ?? 0;
        if (Math.abs(pa - pb) > 0.001) return pb - pa;
        // Tie-break by volume
        return parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0");
      })
      .slice(0, 7);
  } else {
    top = [...markets]
      .sort((a, b) => parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0"))
      .slice(0, 5);
  }

  return (
    <div className="space-y-1">
      {hasLikelihoods && (
        <p className="text-[10px] text-kalshi-muted mb-1">
          Highlighted by forecast likelihood
        </p>
      )}
      {top.map((m) => {
        const yesPrice = parseFloat(m.yes_bid_dollars || "0");
        const noPrice = parseFloat(m.no_bid_dollars || "0");
        const vol24 = parseFloat(m.volume_24h_fp || "0");
        const strikeLabel = formatStrike(m, subcategory);
        const prob = probMap.get(m.ticker) ?? 0;
        const highlighted = prob >= HIGHLIGHT_THRESHOLD;

        return (
          <div
            key={m.ticker}
            className="flex items-center justify-between py-1.5 px-2 rounded transition-colors"
            style={
              highlighted
                ? {
                    backgroundColor: `rgba(46, 204, 113, ${prob * 0.28})`,
                    borderLeft: `3px solid rgba(46, 204, 113, ${Math.min(1, prob * 0.7)})`,
                    paddingLeft: "8px",
                  }
                : undefined
            }
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
              {highlighted && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-bold text-kalshi-green"
                  style={{ backgroundColor: `rgba(46, 204, 113, ${prob * 0.2})` }}
                >
                  {Math.round(prob * 100)}%
                </span>
              )}
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
