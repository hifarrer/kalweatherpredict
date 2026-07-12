"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EnrichedEvent } from "@/types";
import Header from "@/components/Header";
import CryptoEventCard from "@/components/crypto/CryptoEventCard";
import CryptoFilters, {
  CryptoFilterState,
  DEFAULT_CRYPTO_FILTERS,
  matchesHorizon,
} from "@/components/crypto/CryptoFilters";
import { CryptoAssetContext } from "@/lib/crypto/cryptoEnrich";

const REFRESH_INTERVAL_MS = 60 * 1000;

interface CryptoEventsResponse {
  events: EnrichedEvent[];
  contexts: Record<string, CryptoAssetContext>;
  error?: string;
}

interface AdvantageRow {
  eventTicker: string;
  eventTitle: string;
  asset: string | null;
  closeTime: string;
  suggestion: {
    ticker: string;
    marketTitle: string;
    side: "yes" | "no";
    price: number;
    winProb: number;
    evPerContract: number;
    score: number;
    rationale: string;
  };
  estProfitPer100: number;
}

export default function CryptoDashboard() {
  const [data, setData] = useState<CryptoEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<CryptoFilterState>(DEFAULT_CRYPTO_FILTERS);
  const [advantage, setAdvantage] = useState<AdvantageRow[] | null>(null);
  const [advantageOpen, setAdvantageOpen] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/crypto/events?sort=expiration${refresh ? "&refresh=1" : ""}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as CryptoEventsResponse;
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load crypto events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!advantageOpen || advantage) return;
    fetch("/api/crypto/advantage", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setAdvantage(j.rows ?? []))
      .catch(() => setAdvantage([]));
  }, [advantageOpen, advantage]);

  const counts = useMemo(() => {
    const byAsset: Record<string, number> = {};
    for (const e of data?.events ?? []) {
      if (e.asset) byAsset[e.asset] = (byAsset[e.asset] ?? 0) + 1;
    }
    return { all: data?.events.length ?? 0, byAsset };
  }, [data]);

  const visible = useMemo(() => {
    let events = [...(data?.events ?? [])];
    if (filters.asset !== "all") events = events.filter((e) => e.asset === filters.asset);
    if (filters.minVolume > 0) events = events.filter((e) => e.volume24h >= filters.minVolume);
    events = events.filter((e) => matchesHorizon(e.earliestClose, filters.horizon));
    switch (filters.sort) {
      case "volume":
        events.sort((a, b) => b.volume24h - a.volume24h);
        break;
      case "edge":
        events.sort((a, b) => Math.abs(b.maxEdge ?? 0) - Math.abs(a.maxEdge ?? 0));
        break;
      default:
        events.sort((a, b) => (a.earliestClose || "").localeCompare(b.earliestClose || ""));
    }
    return events;
  }, [data, filters]);

  return (
    <div className="min-h-screen">
      <Header onRefresh={() => load(true)} loading={loading} />

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-4">
        <CryptoFilters filters={filters} counts={counts} onChange={setFilters} />

        {/* Collapsible EV opportunities table */}
        <div className="rounded-2xl border border-kalshi-border bg-kalshi-surface/40">
          <button
            onClick={() => setAdvantageOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-bold text-kalshi-text"
          >
            <span>⚡ Top opportunities (fee-adjusted EV)</span>
            <span className="text-kalshi-muted">{advantageOpen ? "▾" : "▸"}</span>
          </button>
          {advantageOpen && (
            <div className="px-4 pb-4 overflow-x-auto">
              {!advantage ? (
                <p className="text-xs text-kalshi-muted py-2">Loading...</p>
              ) : advantage.length === 0 ? (
                <p className="text-xs text-kalshi-muted py-2">
                  No positive-EV opportunities right now.
                </p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-kalshi-muted text-left">
                      <th className="py-1.5 pr-3">Asset</th>
                      <th className="py-1.5 pr-3">Market</th>
                      <th className="py-1.5 pr-3">Side</th>
                      <th className="py-1.5 pr-3">Ask</th>
                      <th className="py-1.5 pr-3">Win prob</th>
                      <th className="py-1.5 pr-3">EV/contract</th>
                      <th className="py-1.5 pr-3">Est. profit / $100</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advantage.slice(0, 15).map((r) => (
                      <tr
                        key={`${r.suggestion.ticker}:${r.suggestion.side}`}
                        className="border-t border-kalshi-border/50"
                        title={r.suggestion.rationale}
                      >
                        <td className="py-1.5 pr-3 font-bold text-kalshi-orange">
                          {r.asset}
                        </td>
                        <td className="py-1.5 pr-3 text-kalshi-text">
                          {r.eventTitle} — {r.suggestion.marketTitle}
                        </td>
                        <td
                          className={`py-1.5 pr-3 font-bold uppercase ${
                            r.suggestion.side === "yes"
                              ? "text-kalshi-green"
                              : "text-kalshi-red"
                          }`}
                        >
                          {r.suggestion.side}
                        </td>
                        <td className="py-1.5 pr-3">
                          {Math.round(r.suggestion.price * 100)}¢
                        </td>
                        <td className="py-1.5 pr-3">
                          {Math.round(r.suggestion.winProb * 100)}%
                        </td>
                        <td className="py-1.5 pr-3 text-kalshi-green">
                          +{Math.round(r.suggestion.evPerContract * 100)}¢
                        </td>
                        <td className="py-1.5 pr-3 text-kalshi-green">
                          +${r.estProfitPer100.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {loading && !data && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-10 h-10 border-3 border-kalshi-orange border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-kalshi-muted">Loading crypto markets...</p>
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl bg-kalshi-red/10 border border-kalshi-red/30">
            <p className="text-sm text-kalshi-red font-medium">{error}</p>
          </div>
        )}

        {data && visible.length === 0 && !loading && (
          <p className="text-sm text-kalshi-muted py-12 text-center">
            No open crypto events match the filters.
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
          {visible.map((e) => (
            <CryptoEventCard
              key={e.event.event_ticker}
              enriched={e}
              context={e.asset ? data?.contexts[e.asset] : undefined}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
