"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EnrichedEvent, KalshiMarket, WeatherForecast } from "@/types";
import Header from "@/components/Header";
import EventDetailModal from "@/components/EventDetailModal";
import { BuySide } from "@/components/MarketsTable";

interface AdvantageRow {
  eventTicker: string;
  eventTitle: string;
  cityCode: string | null;
  subcategory: string;
  marketTicker: string;
  marketTitle: string;
  side: BuySide;
  price: number;
  forecastProb: number;
  marketProb: number | null;
  evPerContract: number;
  estProfitPer100: number;
  kind: "consensus" | "value";
  rationale: string;
  closeTime: string;
  volume24h: number;
  leadDays: number | null;
  market: KalshiMarket;
}

interface AdvantageScan {
  rows: AdvantageRow[];
  eventsScanned: number;
  generatedAt: string;
}

type LeadFilter = "all" | "today" | "tomorrow";

export default function AdvantagePage() {
  const [scan, setScan] = useState<AdvantageScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minEv, setMinEv] = useState(5); // cents
  const [leadFilter, setLeadFilter] = useState<LeadFilter>("all");
  const [detail, setDetail] = useState<EnrichedEvent | null>(null);
  const [detailForecast, setDetailForecast] = useState<WeatherForecast | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/advantage${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);
      setScan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    if (!scan) return [];
    return scan.rows.filter((r) => {
      if (r.evPerContract * 100 < minEv) return false;
      if (leadFilter === "today" && r.leadDays !== 0) return false;
      if (leadFilter === "tomorrow" && r.leadDays !== 1) return false;
      return true;
    });
  }, [scan, minEv, leadFilter]);

  const bestEv = rows.length > 0 ? Math.round(rows[0].evPerContract * 100) : 0;

  const openDetails = async (eventTicker: string, cityCode: string | null) => {
    setDetailLoading(eventTicker);
    try {
      const [eventRes, weatherRes] = await Promise.all([
        fetch(`/api/events/${encodeURIComponent(eventTicker)}`, { cache: "no-store" }),
        cityCode
          ? fetch(`/api/weather?cities=${encodeURIComponent(cityCode)}`).catch(() => null)
          : Promise.resolve(null),
      ]);
      const data = await eventRes.json();
      if (data.event) {
        let forecast: WeatherForecast | null = null;
        if (weatherRes?.ok) {
          const weatherData = await weatherRes.json().catch(() => null);
          forecast = weatherData?.forecasts?.[cityCode!] ?? null;
        }
        setDetailForecast(forecast);
        setDetail(data.event);
      }
    } finally {
      setDetailLoading(null);
    }
  };

  const runSummary = async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const res = await fetch("/api/advantage/summary", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Summary failed");
      setSummary(data.summary);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Summary failed");
    } finally {
      setSummaryLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header onRefresh={() => load(true)} loading={loading} />

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-kalshi-text">AI Advantage</h1>
          <p className="text-xs text-kalshi-muted">
            Every open event scanned for gaps between forecast probability and market
            price — the biggest expected-value plays first.
          </p>
        </div>

        {/* Summary strip */}
        {scan && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Opportunities" value={String(rows.length)} />
            <Stat label="Best EV / contract" value={rows.length ? `+${bestEv}¢` : "—"} />
            <Stat label="Events scanned" value={String(scan.eventsScanned)} />
            <Stat
              label="Last scan"
              value={new Date(scan.generatedAt).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            />
          </div>
        )}

        {/* AI briefing */}
        <div className="rounded-xl border border-purple-500/30 bg-gradient-to-r from-purple-600/10 to-indigo-600/10 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-purple-300">AI Briefing</h2>
            <button
              onClick={runSummary}
              disabled={summaryLoading || !scan || scan.rows.length === 0}
              className="px-3 py-1.5 rounded-lg bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 text-purple-200 text-xs font-semibold transition-colors disabled:opacity-40"
            >
              {summaryLoading ? "Analyzing..." : summary ? "Regenerate" : "Generate briefing"}
            </button>
          </div>
          {summaryError && <p className="text-xs text-kalshi-red">{summaryError}</p>}
          {summary ? (
            <p className="text-xs text-kalshi-text whitespace-pre-line leading-relaxed">{summary}</p>
          ) : (
            !summaryLoading && (
              <p className="text-xs text-kalshi-muted">
                Claude reviews the top opportunities below — strongest plays, correlated
                risks, and anything that looks too good to be true. Cached 30 minutes.
              </p>
            )
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 flex-wrap text-xs">
          <div className="flex items-center gap-2">
            <span className="text-kalshi-muted">Min EV:</span>
            <input
              type="range"
              min={5}
              max={40}
              step={1}
              value={minEv}
              onChange={(e) => setMinEv(Number(e.target.value))}
              className="accent-kalshi-orange"
            />
            <span className="text-kalshi-text font-bold w-10">+{minEv}¢</span>
          </div>
          <div className="flex items-center gap-1">
            {(["all", "today", "tomorrow"] as LeadFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setLeadFilter(f)}
                className={`px-3 py-1.5 rounded-lg font-medium capitalize transition-colors ${
                  leadFilter === f
                    ? "bg-kalshi-orange text-white"
                    : "bg-white/5 text-kalshi-muted hover:text-kalshi-text"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        {loading && !scan ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-10 h-10 border-3 border-kalshi-orange border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-kalshi-muted">Scanning all events for opportunities...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl bg-kalshi-red/10 border border-kalshi-red/30">
            <p className="text-sm text-kalshi-red font-medium">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
            <p className="text-sm text-kalshi-text font-medium">No qualifying opportunities</p>
            <p className="text-xs text-kalshi-muted">
              No liquid market currently offers +{minEv}¢ or more of expected value. Try
              lowering the minimum EV or check back after the next forecast update.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-kalshi-border bg-kalshi-surface overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-kalshi-muted text-left border-b border-kalshi-border">
                  <th className="font-semibold p-3">Event</th>
                  <th className="font-semibold p-3">Market</th>
                  <th className="font-semibold p-3">Side</th>
                  <th className="font-semibold p-3 text-right">Forecast %</th>
                  <th className="font-semibold p-3 text-right">Price</th>
                  <th className="font-semibold p-3 text-right" title="Expected value per contract">EV</th>
                  <th className="font-semibold p-3 text-right" title="Expected profit on a $100 stake">Est. profit / $100</th>
                  <th className="font-semibold p-3 text-right">Closes</th>
                  <th className="font-semibold p-3 text-right">24h Vol</th>
                  <th className="font-semibold p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.marketTicker}:${r.side}`}
                    className="border-b border-kalshi-border/50 last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="p-3 max-w-[260px]">
                      <span className="block truncate text-kalshi-text" title={r.eventTitle}>
                        {r.eventTitle}
                      </span>
                      <span className="text-[10px] text-kalshi-muted">
                        {r.cityCode ?? ""}
                        {r.leadDays != null &&
                          ` · ${r.leadDays === 0 ? "today" : r.leadDays === 1 ? "tomorrow" : `${r.leadDays}d out`}`}
                        {r.kind === "consensus" && " · consensus pick"}
                      </span>
                    </td>
                    <td className="p-3 text-kalshi-text">{r.marketTitle}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                          r.side === "yes"
                            ? "bg-kalshi-green/15 text-kalshi-green"
                            : "bg-kalshi-red/15 text-kalshi-red"
                        }`}
                      >
                        {r.side}
                      </span>
                    </td>
                    <td className="p-3 text-right font-bold text-kalshi-green">
                      {Math.round((r.side === "yes" ? r.forecastProb : 1 - r.forecastProb) * 100)}%
                    </td>
                    <td className="p-3 text-right text-kalshi-text">{Math.round(r.price * 100)}¢</td>
                    <td className="p-3 text-right">
                      <span className="px-1.5 py-0.5 rounded font-bold text-kalshi-green bg-kalshi-green/15">
                        +{Math.round(r.evPerContract * 100)}¢
                      </span>
                    </td>
                    <td className="p-3 text-right text-kalshi-text">
                      {r.estProfitPer100 >= 0 ? "+" : ""}${r.estProfitPer100.toFixed(0)}
                    </td>
                    <td className="p-3 text-right text-kalshi-muted">{formatClose(r.closeTime)}</td>
                    <td className="p-3 text-right text-kalshi-muted">{Math.round(r.volume24h)}</td>
                    <td className="p-3 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          onClick={() => openDetails(r.eventTicker, r.cityCode)}
                          disabled={detailLoading === r.eventTicker}
                          className="px-2.5 py-1 rounded-md text-[10px] font-medium border border-kalshi-border text-kalshi-muted hover:text-kalshi-text hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                          {detailLoading === r.eventTicker ? "..." : "Details"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {detail && (
        <EventDetailModal
          enriched={detail}
          forecast={detailForecast}
          isOpen
          onClose={() => {
            setDetail(null);
            setDetailForecast(null);
          }}
          onRefreshed={(updated) => setDetail(updated)}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-3">
      <p className="text-[10px] uppercase tracking-wide text-kalshi-muted">{label}</p>
      <p className="text-lg font-bold text-kalshi-text">{value}</p>
    </div>
  );
}

function formatClose(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
    });
  } catch {
    return iso;
  }
}
