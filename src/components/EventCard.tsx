"use client";

import { useState, useEffect } from "react";
import { EnrichedEvent, WeatherForecast } from "@/types";
import { CITY_MAP } from "@/lib/cities";
import { parseDateFromTitle, utcToLocalDateString } from "@/lib/predictor";
import PredictionBadge from "./PredictionBadge";
import WeatherChip from "./WeatherChip";
import MarketsList from "./MarketsList";
import AiAnalysisModal from "./AiAnalysisModal";
import ForecastPanel from "./ForecastPanel";

interface EventCardProps {
  enriched: EnrichedEvent;
  forecast: WeatherForecast | null;
  /** Called with the refreshed enriched event after a successful per-card refresh. */
  onRefreshed?: (updated: EnrichedEvent) => void;
}

export default function EventCard({ enriched, forecast, onRefreshed }: EventCardProps) {
  const [aiOpen, setAiOpen] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Ticks every minute so the countdown-to-close chip stays fresh
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowTs(Date.now()), 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Local copy of enriched data so per-card refresh can update it in-place
  const [localEnriched, setLocalEnriched] = useState(enriched);

  // Sync from prop when the parent passes new data (e.g. main refresh)
  useEffect(() => {
    setLocalEnriched(enriched);
  }, [enriched]);

  const { event, cityCode, prediction, volume24h, earliestClose, opportunityScore } = localEnriched;
  const city = cityCode ? CITY_MAP[cityCode] : null;
  const kalshiUrl = `https://kalshi.com/markets/${event.event_ticker.toLowerCase()}`;

  // Determine the event date for forecast deep-linking.
  // Uses the city's timezone when converting UTC timestamps so that
  // a strike_date like "2026-07-03T03:59:00Z" correctly maps to the
  // local date (Jul 2 in CDT) rather than the UTC date (Jul 3).
  const eventDate = parseDateFromTitle(event.title) ??
    (event.strike_date ? utcToLocalDateString(event.strike_date, city?.timezone) : null);

  // Fetch fresh market data for this single event directly from Kalshi
  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(event.event_ticker)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to refresh (${res.status})`);
      }
      const data = await res.json();
      if (data.event) {
        setLocalEnriched(data.event);
        onRefreshed?.(data.event);
      }
    } catch (err) {
      setRefreshError(
        err instanceof Error ? err.message : "Failed to refresh",
      );
    } finally {
      setRefreshing(false);
      // Clear error after 5s
      setTimeout(() => setRefreshError(null), 5000);
    }
  };

  return (
    <>
      <div className="bg-kalshi-surface border border-kalshi-border rounded-xl overflow-hidden hover:border-white/20 transition-all flex flex-col">
        {/* Top: Prediction Badge + Opportunity Badge + Per-event Refresh */}
        <div className="p-4 pb-2 flex items-center gap-2 flex-wrap">
          <PredictionBadge prediction={prediction} />
          {opportunityScore != null && opportunityScore > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-kalshi-green/20 border border-kalshi-green/40 text-kalshi-green">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              Opportunity {opportunityScore}/100
            </span>
          )}
          {/* Spacer pushes the refresh button to the right */}
          <div className="flex-1" />
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh market prices for this event"
            className="p-1 rounded-md text-kalshi-muted hover:text-kalshi-orange hover:bg-white/5 disabled:opacity-40 disabled:cursor-wait transition-colors"
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
        </div>

        {/* Refresh error toast (per-card) */}
        {refreshError && (
          <div className="mx-4 mb-1 px-2 py-1 rounded-md bg-kalshi-red/10 border border-kalshi-red/30">
            <span className="text-[10px] text-kalshi-red">{refreshError}</span>
          </div>
        )}

        {/* Title */}
        <div className="px-4 pb-2">
          <a
            href={kalshiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-sm font-bold text-kalshi-text hover:text-kalshi-orange leading-snug line-clamp-2 transition-colors"
          >
            {event.title}
          </a>
          {event.sub_title && (
            <p className="text-xs text-kalshi-muted mt-0.5">{event.sub_title}</p>
          )}
        </div>

        {/* Weather chip / Multi-city summary */}
        <div className="px-4 pb-3">
          {prediction?.multiCity && prediction.matchedCount !== undefined ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-xs">
              <svg
                className="w-4 h-4 text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              <span className="text-kalshi-muted">
                {prediction.matchedCount} of{" "}
                {(prediction.marketLikelihoods ?? []).filter((ml) => ml.cityCode).length}{" "}
                cities forecast match
              </span>
            </div>
          ) : (
            <WeatherChip
              forecast={forecast}
              cityLabel={city?.label ?? null}
              lat={city?.lat}
              lon={city?.lon}
              eventDate={eventDate}
            />
          )}
        </div>

        {/* Forecast detail toggle */}
        {forecast && (
          <div className="px-4 pb-2">
            <button
              onClick={() => setForecastOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-kalshi-muted hover:text-kalshi-orange transition-colors"
            >
              <svg
                className={`w-3 h-3 transition-transform ${forecastOpen ? "rotate-90" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Forecast detail
            </button>
            {forecastOpen && <ForecastPanel forecast={forecast} prediction={prediction} />}
          </div>
        )}

        {/* Divider */}
        <div className="border-t border-kalshi-border" />

        {/* Markets */}
        <div className="p-3 flex-1">
          <MarketsList
            markets={event.markets}
            subcategory={localEnriched.subcategory}
            marketLikelihoods={prediction?.marketLikelihoods}
            agreement={prediction?.agreement}
          />
        </div>

        {/* Footer: stats + actions */}
        <div className="border-t border-kalshi-border p-3 space-y-2">
          {/* Stats row */}
          <div className="flex items-center justify-between text-[10px] text-kalshi-muted">
            <span>24h Vol: {formatVolume(volume24h)}</span>
            {earliestClose && (
              <span className="flex items-center gap-1.5">
                <span>Closes: {formatDate(earliestClose, city?.timezone)}</span>
                <CountdownChip closeIso={earliestClose} nowTs={nowTs} />
              </span>
            )}
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAiOpen(true)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-gradient-to-r from-purple-600/20 to-indigo-600/20 border border-purple-500/30 hover:from-purple-600/30 hover:to-indigo-600/30 text-purple-300 hover:text-purple-200 text-xs font-semibold transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              Deep AI Analysis
            </button>
            <a
              href={kalshiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-lg border border-kalshi-border hover:bg-white/5 text-kalshi-muted hover:text-kalshi-text text-xs font-medium transition-colors flex items-center gap-1"
            >
              View
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>
      </div>

      {/* AI Modal */}
      <AiAnalysisModal
        eventTicker={event.event_ticker}
        eventTitle={event.title}
        isOpen={aiOpen}
        onClose={() => setAiOpen(false)}
      />
    </>
  );
}

function CountdownChip({ closeIso, nowTs }: { closeIso: string; nowTs: number }) {
  const label = formatCountdown(closeIso, nowTs);
  if (!label) return null;

  const msLeft = new Date(closeIso).getTime() - nowTs;
  const urgent = msLeft < 3 * 60 * 60 * 1000; // amber under 3 hours

  return (
    <span
      className={`px-1.5 py-0.5 rounded font-semibold ${
        urgent ? "bg-amber-500/15 text-amber-400" : "bg-white/5 text-kalshi-muted"
      }`}
    >
      {label}
    </span>
  );
}

function formatCountdown(closeIso: string, nowTs: number): string | null {
  const ms = new Date(closeIso).getTime() - nowTs;
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return String(Math.round(vol));
}

function formatDate(iso: string, timezone?: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return iso.split("T")[0];
  }
}
