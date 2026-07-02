"use client";

import { useState } from "react";
import { EnrichedEvent, WeatherForecast } from "@/types";
import { CITY_MAP } from "@/lib/cities";
import PredictionBadge from "./PredictionBadge";
import WeatherChip from "./WeatherChip";
import MarketsList from "./MarketsList";
import AiAnalysisModal from "./AiAnalysisModal";

interface EventCardProps {
  enriched: EnrichedEvent;
  forecast: WeatherForecast | null;
}

export default function EventCard({ enriched, forecast }: EventCardProps) {
  const [aiOpen, setAiOpen] = useState(false);
  const { event, cityCode, prediction, volume24h, earliestClose, opportunityScore } = enriched;
  const city = cityCode ? CITY_MAP[cityCode] : null;
  const kalshiUrl = `https://kalshi.com/markets/${event.series_ticker.toLowerCase()}`;

  return (
    <>
      <div className="bg-kalshi-surface border border-kalshi-border rounded-xl overflow-hidden hover:border-white/20 transition-all flex flex-col">
        {/* Top: Prediction Badge + Opportunity Badge */}
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
        </div>

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

        {/* Weather chip */}
        <div className="px-4 pb-3">
          <WeatherChip forecast={forecast} cityLabel={city?.label ?? null} />
        </div>

        {/* Divider */}
        <div className="border-t border-kalshi-border" />

        {/* Markets */}
        <div className="p-3 flex-1">
          <MarketsList markets={event.markets} subcategory={enriched.subcategory} />
        </div>

        {/* Footer: stats + actions */}
        <div className="border-t border-kalshi-border p-3 space-y-2">
          {/* Stats row */}
          <div className="flex items-center justify-between text-[10px] text-kalshi-muted">
            <span>24h Vol: {formatVolume(volume24h)}</span>
            {earliestClose && (
              <span>Closes: {formatDate(earliestClose)}</span>
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

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return String(Math.round(vol));
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso.split("T")[0];
  }
}
