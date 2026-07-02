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

  // Build likelihood lookup map
  const llMap = new Map<string, MarketLikelihood>();
  if (marketLikelihoods) {
    for (const ml of marketLikelihoods) {
      llMap.set(ml.ticker, ml);
    }
  }

  const hasLikelihoods = llMap.size > 0;
  const unit = subcategory === "precipitation" || subcategory === "snowfall" ? "in" : "°F";

  // When we have likelihoods, sort by probability desc and show up to 10.
  // Otherwise fall back to top 5 by 24h volume.
  let top: KalshiMarket[];
  if (hasLikelihoods) {
    top = [...markets]
      .sort((a, b) => {
        const pa = llMap.get(a.ticker)?.probability ?? 0;
        const pb = llMap.get(b.ticker)?.probability ?? 0;
        if (Math.abs(pa - pb) > 0.001) return pb - pa;
        // Tie-break by volume
        return parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0");
      })
      .slice(0, 10);
  } else {
    top = [...markets]
      .sort((a, b) => parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0"))
      .slice(0, 5);
  }

  return (
    <div className="space-y-1">
      {hasLikelihoods && (
        <div className="flex items-center gap-3 mb-1 text-[10px] text-kalshi-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-kalshi-green" />
            FC = Forecast
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-amber-500" />
            MK = Kalshi Market
          </span>
        </div>
      )}
      {top.map((m) => {
        const yesPrice = parseFloat(m.yes_bid_dollars || "0");
        const noPrice = parseFloat(m.no_bid_dollars || "0");
        const lastPrice = parseFloat(m.last_price_dollars || "0");
        const vol24 = parseFloat(m.volume_24h_fp || "0");
        const strikeLabel = formatStrike(m, subcategory);
        const ll = llMap.get(m.ticker);
        const prob = ll?.probability ?? 0;
        const fcValue = ll?.forecastValue;
        const highlighted = prob >= HIGHLIGHT_THRESHOLD;
        // Market-implied probability: prefer last traded price, fall back to bid midpoint
        const marketProb = lastPrice > 0
          ? lastPrice
          : yesPrice > 0
            ? yesPrice
            : 0;

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
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-kalshi-text truncate">
                  {m.yes_sub_title || m.ticker}
                </span>
                {fcValue !== undefined && (
                  <span className="text-[10px] text-blue-400 font-medium shrink-0">
                    {fcValue}{unit}
                  </span>
                )}
              </div>
              {strikeLabel && (
                <span className="text-[10px] text-kalshi-muted">{strikeLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Forecast probability badge */}
              {hasLikelihoods && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-bold text-kalshi-green"
                  style={{
                    backgroundColor: `rgba(46, 204, 113, ${Math.max(0.06, prob * 0.2)})`,
                    opacity: highlighted ? 1 : 0.55,
                  }}
                  title="Forecast-implied probability"
                >
                  {Math.round(prob * 100)}%
                </span>
              )}
              {/* Kalshi market-implied probability badge */}
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-amber-400"
                style={{
                  backgroundColor: `rgba(245, 158, 11, ${Math.max(0.06, marketProb * 0.2)})`,
                }}
                title="Kalshi market price (last traded)"
              >
                {Math.round(marketProb * 100)}%
              </span>
              {/* Bid prices */}
              <div className="flex items-center gap-0.5">
                <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-kalshi-green/15 text-kalshi-green">
                  {Math.round(yesPrice * 100)}¢
                </span>
                <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-kalshi-red/15 text-kalshi-red">
                  {Math.round(noPrice * 100)}¢
                </span>
              </div>
              <span className="text-[10px] text-kalshi-muted w-12 text-right">
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
