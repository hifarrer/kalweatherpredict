"use client";

import { useEffect, useMemo, useState } from "react";
import { EnrichedEvent, KalshiMarket } from "@/types";
import { buildKalshiEventUrl } from "@/lib/kalshi";
import MarketsList from "@/components/MarketsList";
import SuggestedActions from "@/components/SuggestedActions";
import TradeModal, { TradeSuggestion } from "@/components/TradeModal";
import AiAnalysisModal from "@/components/AiAnalysisModal";
import { BuySide } from "@/components/MarketsTable";
import { CryptoAssetContext } from "@/lib/crypto/cryptoEnrich";

interface CryptoEventCardProps {
  enriched: EnrichedEvent;
  context?: CryptoAssetContext;
}

function fmtUsd(v: number, digits = 0): string {
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

function countdownLabel(closeIso: string, nowTs: number): { label: string; urgent: boolean } {
  const ms = new Date(closeIso).getTime() - nowTs;
  if (!Number.isFinite(ms) || ms <= 0) return { label: "closed", urgent: false };
  const min = Math.floor(ms / 60000);
  if (min < 60) return { label: `${min}m`, urgent: min <= 15 };
  const h = Math.floor(min / 60);
  if (h < 24) return { label: `${h}h ${min % 60}m`, urgent: false };
  return { label: `${Math.floor(h / 24)}d ${h % 24}h`, urgent: false };
}

/**
 * One crypto event: spot/σ context, model-vs-market strike ladder, and the
 * suggestion panel with trading. Mirrors the weather EventCard shell but the
 * "forecast" chips are live market data instead of weather models.
 */
export default function CryptoEventCard({ enriched, context }: CryptoEventCardProps) {
  const { event, prediction, volume24h, earliestClose } = enriched;
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [trade, setTrade] = useState<{
    market: KalshiMarket;
    side: BuySide;
    suggestion?: TradeSuggestion;
  } | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const countdown = useMemo(
    () => countdownLabel(earliestClose, nowTs),
    [earliestClose, nowTs],
  );

  const sigmaPct =
    prediction?.tauHours !== undefined && prediction.sigma !== undefined
      ? prediction.sigma * 100
      : null;

  return (
    <div className="rounded-2xl border border-kalshi-border bg-kalshi-surface/60 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <a
              href={buildKalshiEventUrl(event)}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-bold text-kalshi-text hover:text-kalshi-orange transition-colors leading-snug"
            >
              {event.title}
            </a>
            {event.sub_title && (
              <p className="text-xs text-kalshi-muted mt-0.5">{event.sub_title}</p>
            )}
          </div>
          <span
            className={`shrink-0 px-2 py-1 rounded-lg text-[11px] font-bold ${
              countdown.urgent
                ? "bg-kalshi-red/15 text-kalshi-red animate-pulse"
                : "bg-white/5 text-kalshi-muted"
            }`}
            title="Time until settlement"
          >
            ⏱ {countdown.label}
          </span>
        </div>

        {/* Market context chips */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {enriched.asset && (
            <span className="px-2 py-1 rounded-lg bg-kalshi-orange/15 text-kalshi-orange font-bold">
              {enriched.asset}
            </span>
          )}
          {context && (
            <span
              className="px-2 py-1 rounded-lg bg-white/5 text-kalshi-text font-semibold"
              title={`Spot via ${context.spot.source}, ${Math.round((nowTs - context.spot.ts) / 1000)}s ago`}
            >
              Spot {fmtUsd(context.spot.price, context.spot.price < 100 ? 2 : 0)}
            </span>
          )}
          {context?.rvs.rv24h != null && (
            <span
              className="px-2 py-1 rounded-lg bg-white/5 text-kalshi-muted"
              title="Annualized realized volatility (24h window of 1m returns)"
            >
              RV24h {(context.rvs.rv24h * 100).toFixed(0)}%
            </span>
          )}
          {context?.dvol != null && (
            <span
              className="px-2 py-1 rounded-lg bg-white/5 text-kalshi-muted"
              title="Deribit DVOL implied volatility index"
            >
              IV {(context.dvol * 100).toFixed(0)}%
            </span>
          )}
          {sigmaPct !== null && (
            <span
              className="px-2 py-1 rounded-lg bg-white/5 text-kalshi-muted"
              title="Model σ over the remaining horizon (log-space)"
            >
              σ√τ {sigmaPct.toFixed(2)}%
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          {prediction ? (
            <p className="text-[11px] text-kalshi-muted">{prediction.detail}</p>
          ) : (
            <span />
          )}
          <button
            onClick={() => setAnalysisOpen(true)}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-kalshi-orange/20 text-[11px] font-semibold text-kalshi-orange transition-colors"
            title="Deep AI analysis of this event"
          >
            ✨ Analyze
          </button>
        </div>
      </div>

      <div className="border-t border-kalshi-border" />

      {/* Strike ladder */}
      <div className="p-3 flex-1">
        <MarketsList
          markets={event.markets}
          subcategory="crypto_price"
          marketLikelihoods={prediction?.marketLikelihoods}
        />
      </div>

      {/* Suggestions + trading */}
      <div className="border-t border-kalshi-border p-3 space-y-3">
        <SuggestedActions
          enriched={enriched}
          reviewEndpoint="/api/crypto/review"
          onBuy={(market, side, suggestion) => setTrade({ market, side, suggestion })}
        />
        <div className="flex items-center justify-between text-[10px] text-kalshi-muted">
          <span>24h Vol: {volume24h.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
          <span>{event.markets?.length ?? 0} strikes</span>
        </div>
      </div>

      {trade && (
        <TradeModal
          market={trade.market}
          side={trade.side}
          eventTicker={event.event_ticker}
          eventTitle={event.title}
          isOpen={true}
          onClose={() => setTrade(null)}
          suggestion={trade.suggestion}
        />
      )}
      <AiAnalysisModal
        eventTicker={event.event_ticker}
        eventTitle={event.title}
        isOpen={analysisOpen}
        onClose={() => setAnalysisOpen(false)}
        endpoint="/api/crypto/analyze"
      />
    </div>
  );
}
