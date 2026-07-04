"use client";

import { useMemo } from "react";
import { EnrichedEvent, KalshiMarket } from "@/types";
import { computeSuggestedActions } from "@/lib/suggest";
import { formatStrike } from "@/lib/format";
import { BuySide } from "./MarketsTable";

interface SuggestedActionsProps {
  enriched: EnrichedEvent;
  onBuy: (market: KalshiMarket, side: BuySide) => void;
}

/**
 * Algorithmic trade suggestions for the maximized event view:
 * consensus buckets (closest to the forecast) and positive-EV plays.
 */
export default function SuggestedActions({ enriched, onBuy }: SuggestedActionsProps) {
  const suggestions = useMemo(() => computeSuggestedActions(enriched), [enriched]);
  const marketByTicker = useMemo(
    () => new Map((enriched.event.markets ?? []).map((m) => [m.ticker, m])),
    [enriched],
  );

  return (
    <section>
      <h3 className="text-xs font-bold uppercase tracking-wide text-kalshi-muted mb-2">
        Suggested actions
      </h3>
      {suggestions.length === 0 ? (
        <div className="rounded-xl border border-kalshi-border bg-black/20 p-4">
          <p className="text-xs text-kalshi-muted">
            No high-confidence suggestions for this event — no liquid market offers
            meaningful expected value at current prices.
          </p>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {suggestions.map((s) => {
            const market = marketByTicker.get(s.ticker);
            const sideColor = s.side === "yes" ? "text-kalshi-green" : "text-kalshi-red";
            const evPositive = s.evPerContract > 0;
            return (
              <div
                key={`${s.ticker}:${s.side}`}
                className="rounded-xl border border-kalshi-border bg-black/20 p-3 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-white/5 ${sideColor}`}>
                    Buy {s.side}
                  </span>
                  <span className="text-xs font-bold text-kalshi-text">
                    {s.marketTitle}
                    {market && (
                      <span className="text-kalshi-muted font-normal">
                        {" "}{formatStrike(market, enriched.subcategory)}
                      </span>
                    )}
                  </span>
                  <span
                    className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      evPositive
                        ? "text-kalshi-green bg-kalshi-green/15"
                        : "text-kalshi-muted bg-white/5"
                    }`}
                    title="Expected value per contract at the current ask"
                  >
                    EV {evPositive ? "+" : ""}
                    {Math.round(s.evPerContract * 100)}¢
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                      s.kind === "consensus"
                        ? "bg-blue-500/15 text-blue-300"
                        : "bg-purple-500/15 text-purple-300"
                    }`}
                  >
                    {s.kind}
                  </span>
                </div>
                <p className="text-[11px] text-kalshi-muted leading-snug">{s.rationale}</p>
                <div className="flex items-center justify-between mt-auto">
                  <span className="text-[10px] text-kalshi-muted">
                    Ask {Math.round(s.price * 100)}¢ · FC {Math.round(s.forecastProb * 100)}%
                    {s.marketProb != null && ` · MK ${Math.round(s.marketProb * 100)}%`}
                  </span>
                  {market && (
                    <button
                      onClick={() => onBuy(market, s.side)}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold text-white transition-colors ${
                        s.side === "yes"
                          ? "bg-kalshi-green hover:bg-green-500"
                          : "bg-kalshi-red hover:bg-red-500"
                      }`}
                    >
                      Buy {s.side.toUpperCase()} {Math.round(s.price * 100)}¢
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
