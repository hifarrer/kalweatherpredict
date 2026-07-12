import { KalshiMarket, MarketLikelihood, MetricKind, ModelAgreement } from "@/types";
import { impliedMarketProb } from "@/lib/predictor";
import { formatStrike, formatVolume } from "@/lib/format";

interface MarketsListProps {
  markets: KalshiMarket[] | undefined;
  subcategory?: MetricKind;
  marketLikelihoods?: MarketLikelihood[];
  agreement?: ModelAgreement;
}

const HIGHLIGHT_THRESHOLD = 0.08; // only highlight markets with >=8% probability
const EDGE_MIN_VOLUME = 100; // hide edge badge on illiquid markets
const EDGE_NOTABLE = 0.05; // gray out edges under ±5%

export default function MarketsList({
  markets,
  subcategory = "temperature_high",
  marketLikelihoods,
  agreement,
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
          <span className="flex items-center gap-1" title="Forecast minus market probability">
            <span className="inline-block w-2 h-2 rounded-sm bg-white/30" />
            ± = Edge
          </span>
        </div>
      )}
      {top.map((m) => {
        const yesPrice = parseFloat(m.yes_bid_dollars || "0");
        const noPrice = parseFloat(m.no_bid_dollars || "0");
        const vol24 = parseFloat(m.volume_24h_fp || "0");
        const strikeLabel = formatStrike(m, subcategory);
        const ll = llMap.get(m.ticker);
        const prob = ll?.probability ?? 0;
        const fcValue = ll?.forecastValue;
        const highlighted = prob >= HIGHLIGHT_THRESHOLD;
        const marketProb = ll?.marketProb ?? impliedMarketProb(m);
        const edge = ll?.edge;
        const decided = ll?.decided === true;
        const showEdge = edge !== undefined && vol24 >= EDGE_MIN_VOLUME;

        // Confidence styling: solid green fill only when models agree;
        // low agreement gets a dimmer, striped fill so uncertainty is visible.
        const lowAgreement = agreement === "low";
        const fillAlpha = prob * (lowAgreement ? 0.16 : 0.28);
        const highlightStyle = highlighted
          ? {
              backgroundColor: lowAgreement ? undefined : `rgba(46, 204, 113, ${fillAlpha})`,
              backgroundImage: lowAgreement
                ? `repeating-linear-gradient(45deg, rgba(46, 204, 113, ${fillAlpha}), rgba(46, 204, 113, ${fillAlpha}) 6px, rgba(46, 204, 113, ${fillAlpha * 0.35}) 6px, rgba(46, 204, 113, ${fillAlpha * 0.35}) 12px)`
                : undefined,
              borderLeft: `3px solid rgba(46, 204, 113, ${Math.min(1, prob * (lowAgreement ? 0.4 : 0.7))})`,
              paddingLeft: "8px",
            }
          : undefined;

        return (
          <div
            key={m.ticker}
            className="flex items-center justify-between py-1.5 px-2 rounded transition-colors"
            style={highlightStyle}
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
                {decided && (
                  <span
                    className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold bg-kalshi-green/20 text-kalshi-green shrink-0"
                    title="Already decided by today's observed weather"
                  >
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Decided
                  </span>
                )}
              </div>
              {strikeLabel && (
                <span className="text-[10px] text-kalshi-muted">{strikeLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Edge badge: forecast prob minus market prob */}
              {showEdge && (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    Math.abs(edge) < EDGE_NOTABLE
                      ? "text-kalshi-muted bg-white/5"
                      : edge > 0
                        ? "text-kalshi-green bg-kalshi-green/15"
                        : "text-kalshi-red bg-kalshi-red/15"
                  }`}
                  title="Forecast probability minus Kalshi market probability"
                >
                  {edge > 0 ? "+" : ""}{Math.round(edge * 100)}
                </span>
              )}
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

