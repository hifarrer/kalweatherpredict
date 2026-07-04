"use client";

import { useEffect, useState } from "react";
import { EnrichedEvent, KalshiMarket, WeatherForecast } from "@/types";
import { CITY_MAP } from "@/lib/cities";
import { buildKalshiEventUrl } from "@/lib/kalshi";
import PredictionBadge from "./PredictionBadge";
import ForecastPanel from "./ForecastPanel";
import MarketsTable, { BuySide } from "./MarketsTable";
import AiAnalysisModal from "./AiAnalysisModal";
import SuggestedActions from "./SuggestedActions";
import TradeModal from "./TradeModal";

interface EventDetailModalProps {
  enriched: EnrichedEvent;
  forecast: WeatherForecast | null;
  isOpen: boolean;
  onClose: () => void;
  /** Called with the refreshed enriched event after an in-modal refresh. */
  onRefreshed?: (updated: EnrichedEvent) => void;
  /** Phase 4: suggested-actions section rendered above the markets table. */
  suggestedActions?: React.ReactNode;
}

/**
 * Maximized event view: expanded forecast, all markets with labeled
 * columns, and (later phases) suggested actions + buy buttons.
 */
export default function EventDetailModal({
  enriched,
  forecast,
  isOpen,
  onClose,
  onRefreshed,
  suggestedActions,
}: EventDetailModalProps) {
  const [aiOpen, setAiOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [trade, setTrade] = useState<{ market: KalshiMarket; side: BuySide } | null>(null);

  const { event, cityCode, prediction, volume24h, earliestClose, opportunityScore } = enriched;
  const city = cityCode ? CITY_MAP[cityCode] : null;
  const kalshiUrl = buildKalshiEventUrl(event);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(event.event_ticker)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to refresh (${res.status})`);
      }
      const data = await res.json();
      if (data.event) onRefreshed?.(data.event);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const obs = forecast?.stationObs;

  return (
    <>
      <div className="fixed inset-0 z-[90] flex items-start justify-center p-4 overflow-y-auto">
        {/* Backdrop */}
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

        {/* Modal */}
        <div className="relative w-full max-w-5xl my-8 bg-kalshi-surface border border-kalshi-border rounded-2xl shadow-2xl">
          {/* Header */}
          <div className="p-5 border-b border-kalshi-border">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-kalshi-text leading-snug">
                  {event.title}
                </h2>
                {event.sub_title && (
                  <p className="text-sm text-kalshi-muted mt-0.5">{event.sub_title}</p>
                )}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <PredictionBadge prediction={prediction} />
                  {opportunityScore != null && opportunityScore > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-kalshi-green/20 border border-kalshi-green/40 text-kalshi-green">
                      Opportunity {opportunityScore}/100
                    </span>
                  )}
                  {city && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/5 text-kalshi-muted">
                      {city.label}
                      {forecast?.stationId ? ` · station ${forecast.stationId}` : ""}
                    </span>
                  )}
                  {earliestClose && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/5 text-kalshi-muted">
                      Closes {formatCloseTime(earliestClose, city?.timezone)}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Refresh market prices"
                  className="p-2 rounded-lg text-kalshi-muted hover:text-kalshi-orange hover:bg-white/5 disabled:opacity-40 disabled:cursor-wait transition-colors"
                >
                  <svg
                    className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => setAiOpen(true)}
                  className="px-3 py-2 rounded-lg bg-gradient-to-r from-purple-600/20 to-indigo-600/20 border border-purple-500/30 hover:from-purple-600/30 hover:to-indigo-600/30 text-purple-300 hover:text-purple-200 text-xs font-semibold transition-all"
                >
                  Deep AI Analysis
                </button>
                <a
                  href={kalshiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 rounded-lg border border-kalshi-border hover:bg-white/5 text-kalshi-muted hover:text-kalshi-text text-xs font-medium transition-colors"
                >
                  Open on Kalshi ↗
                </a>
                <button
                  onClick={onClose}
                  title="Close"
                  className="p-2 rounded-lg text-kalshi-muted hover:text-kalshi-text hover:bg-white/5 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            {refreshError && (
              <div className="mt-2 px-2 py-1 rounded-md bg-kalshi-red/10 border border-kalshi-red/30">
                <span className="text-[10px] text-kalshi-red">{refreshError}</span>
              </div>
            )}
          </div>

          {/* Body */}
          <div className="p-5 space-y-5">
            {/* Same-day station observations */}
            {obs && (obs.max !== null || obs.min !== null) && (
              <div className="px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-kalshi-text">
                <span className="font-semibold text-blue-300">Observed today at {forecast?.stationId}: </span>
                {obs.max !== null && <span>max {obs.max}°F</span>}
                {obs.max !== null && obs.min !== null && <span> · </span>}
                {obs.min !== null && <span>min {obs.min}°F</span>}
                <span className="text-kalshi-muted"> ({obs.count} observations — official settlement station)</span>
              </div>
            )}

            {/* Expanded forecast */}
            {forecast && (
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wide text-kalshi-muted mb-2">
                  Forecast{city ? ` — ${city.label}` : ""}
                </h3>
                <div className="rounded-xl border border-kalshi-border bg-black/20 p-3">
                  <ForecastPanel forecast={forecast} prediction={prediction} />
                </div>
              </section>
            )}

            {/* Suggested actions */}
            {suggestedActions ?? (
              <SuggestedActions
                enriched={enriched}
                onBuy={(market, side) => setTrade({ market, side })}
              />
            )}

            {/* All markets */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-kalshi-muted">
                  All markets ({event.markets?.length ?? 0})
                </h3>
                <span className="text-[10px] text-kalshi-muted">
                  24h Vol: {formatVol(volume24h)}
                </span>
              </div>
              <div className="rounded-xl border border-kalshi-border bg-black/20 p-3">
                <MarketsTable
                  markets={event.markets}
                  subcategory={enriched.subcategory}
                  marketLikelihoods={prediction?.marketLikelihoods}
                  agreement={prediction?.agreement}
                  onBuy={(market, side) => setTrade({ market, side })}
                />
              </div>
            </section>
          </div>
        </div>
      </div>

      <AiAnalysisModal
        eventTicker={event.event_ticker}
        eventTitle={event.title}
        isOpen={aiOpen}
        onClose={() => setAiOpen(false)}
      />

      {trade && (
        <TradeModal
          market={trade.market}
          side={trade.side}
          eventTicker={event.event_ticker}
          eventTitle={event.title}
          isOpen
          onClose={() => setTrade(null)}
        />
      )}
    </>
  );
}

function formatVol(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return String(Math.round(vol));
}

function formatCloseTime(iso: string, timezone?: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return iso;
  }
}
