"use client";

import { KalshiMarket, MarketLikelihood, MetricKind, ModelAgreement } from "@/types";
import { impliedMarketProb } from "@/lib/predictor";
import { formatCents, formatStrike, formatVolume } from "@/lib/format";

export type BuySide = "yes" | "no";

interface MarketsTableProps {
  markets: KalshiMarket[] | undefined;
  subcategory?: MetricKind;
  marketLikelihoods?: MarketLikelihood[];
  agreement?: ModelAgreement;
  /** When provided, each row shows Buy Yes/No buttons (Phase 3 trading). */
  onBuy?: (market: KalshiMarket, side: BuySide) => void;
}

const EDGE_NOTABLE = 0.05;

/**
 * Full market table for the maximized event view: every market, with
 * labeled columns (unlike the compact MarketsList on the dashboard cards).
 */
export default function MarketsTable({
  markets,
  subcategory = "temperature_high",
  marketLikelihoods,
  agreement,
  onBuy,
}: MarketsTableProps) {
  if (!markets || markets.length === 0) {
    return <p className="text-xs text-kalshi-muted">No markets available</p>;
  }

  const llMap = new Map<string, MarketLikelihood>();
  for (const ml of marketLikelihoods ?? []) llMap.set(ml.ticker, ml);
  const hasLikelihoods = llMap.size > 0;

  const sorted = [...markets].sort((a, b) => {
    if (hasLikelihoods) {
      const pa = llMap.get(a.ticker)?.probability ?? 0;
      const pb = llMap.get(b.ticker)?.probability ?? 0;
      if (Math.abs(pa - pb) > 0.001) return pb - pa;
    }
    return parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0");
  });

  const lowAgreement = agreement === "low";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs whitespace-nowrap">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-kalshi-muted text-left border-b border-kalshi-border">
            <th className="font-semibold py-2 pr-2">Outcome</th>
            <th className="font-semibold py-2 px-2">Strike</th>
            <th className="font-semibold py-2 px-2 text-right" title="Forecast-implied probability of YES">Forecast %</th>
            <th className="font-semibold py-2 px-2 text-right" title="Kalshi market-implied probability of YES">Market %</th>
            <th className="font-semibold py-2 px-2 text-right" title="Forecast minus market probability">Edge</th>
            <th className="font-semibold py-2 px-2 text-right">Yes bid/ask</th>
            <th className="font-semibold py-2 px-2 text-right">No bid/ask</th>
            <th className="font-semibold py-2 px-2 text-right">Last</th>
            <th className="font-semibold py-2 px-2 text-right">24h Vol</th>
            {onBuy && <th className="font-semibold py-2 pl-2 text-right">Trade</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const ll = llMap.get(m.ticker);
            const prob = ll?.probability;
            const marketProb = ll?.marketProb ?? impliedMarketProb(m);
            const edge = ll?.edge;
            const decided = ll?.decided === true;
            const highlighted = (prob ?? 0) >= 0.08;
            const fillAlpha = (prob ?? 0) * (lowAgreement ? 0.1 : 0.18);

            return (
              <tr
                key={m.ticker}
                className="border-b border-kalshi-border/50 last:border-0"
                style={
                  highlighted
                    ? { backgroundColor: `rgba(46, 204, 113, ${fillAlpha})` }
                    : undefined
                }
              >
                <td className="py-1.5 pr-2 text-kalshi-text max-w-[220px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{m.yes_sub_title || m.ticker}</span>
                    {ll?.forecastValue !== undefined && (
                      <span className="text-[10px] text-blue-400 font-medium shrink-0">
                        {ll.forecastValue}
                        {subcategory === "precipitation" || subcategory === "snowfall" ? "in" : "°F"}
                      </span>
                    )}
                    {decided && (
                      <span
                        className="px-1 py-0.5 rounded text-[9px] font-bold bg-kalshi-green/20 text-kalshi-green shrink-0"
                        title="Already decided by today's observed weather"
                      >
                        Decided
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-1.5 px-2 text-kalshi-muted">{formatStrike(m, subcategory) || "—"}</td>
                <td className="py-1.5 px-2 text-right">
                  {prob !== undefined ? (
                    <span className="font-bold text-kalshi-green">{Math.round(prob * 100)}%</span>
                  ) : (
                    <span className="text-kalshi-muted">—</span>
                  )}
                </td>
                <td className="py-1.5 px-2 text-right font-bold text-amber-400">
                  {Math.round(marketProb * 100)}%
                </td>
                <td className="py-1.5 px-2 text-right">
                  {edge !== undefined ? (
                    <span
                      className={`px-1.5 py-0.5 rounded font-bold ${
                        Math.abs(edge) < EDGE_NOTABLE
                          ? "text-kalshi-muted bg-white/5"
                          : edge > 0
                            ? "text-kalshi-green bg-kalshi-green/15"
                            : "text-kalshi-red bg-kalshi-red/15"
                      }`}
                    >
                      {edge > 0 ? "+" : ""}
                      {Math.round(edge * 100)}
                    </span>
                  ) : (
                    <span className="text-kalshi-muted">—</span>
                  )}
                </td>
                <td className="py-1.5 px-2 text-right text-kalshi-green">
                  {formatCents(m.yes_bid_dollars)} / {formatCents(m.yes_ask_dollars)}
                </td>
                <td className="py-1.5 px-2 text-right text-kalshi-red">
                  {formatCents(m.no_bid_dollars)} / {formatCents(m.no_ask_dollars)}
                </td>
                <td className="py-1.5 px-2 text-right text-kalshi-text">
                  {formatCents(m.last_price_dollars)}
                </td>
                <td className="py-1.5 px-2 text-right text-kalshi-muted">
                  {formatVolume(parseFloat(m.volume_24h_fp || "0"))}
                </td>
                {onBuy && (
                  <td className="py-1.5 pl-2 text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => onBuy(m, "yes")}
                        className="px-2 py-1 rounded-md text-[10px] font-bold bg-kalshi-green/15 text-kalshi-green hover:bg-kalshi-green/30 transition-colors"
                        title={`Buy YES at ${formatCents(m.yes_ask_dollars)}`}
                      >
                        Yes {formatCents(m.yes_ask_dollars)}
                      </button>
                      <button
                        onClick={() => onBuy(m, "no")}
                        className="px-2 py-1 rounded-md text-[10px] font-bold bg-kalshi-red/15 text-kalshi-red hover:bg-kalshi-red/30 transition-colors"
                        title={`Buy NO at ${formatCents(m.no_ask_dollars)}`}
                      >
                        No {formatCents(m.no_ask_dollars)}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
