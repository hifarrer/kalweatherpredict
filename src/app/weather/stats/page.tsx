"use client";

import { useEffect, useState } from "react";
import { CITY_MAP } from "@/lib/cities";
import type { BotChartsPayload, EvMonitor } from "@/lib/botStats";
import { EvMonitorTable } from "@/components/charts/EvMonitorTable";
import {
  BotPerformanceSection,
  ModelAccuracyCharts,
} from "@/components/charts/BotPerformanceSection";

interface StatsGroup {
  key: string;
  count: number;
  hitRate: number;
  brier: number;
  marketBrier: number | null;
}

interface RecentRow {
  marketTicker: string;
  title: string | null;
  cityCode: string | null;
  metric: string;
  targetDate: string | null;
  predictedProb: number;
  marketProb: number | null;
  result: string;
  forecastValue: number | null;
  actualValue: number | null;
}

interface StatsData {
  charts: BotChartsPayload;
  overall: StatsGroup;
  forecastMae: number | null;
  forecastMaeCount: number;
  byCity: StatsGroup[];
  byMetric: StatsGroup[];
  byLead: StatsGroup[];
  calibration: Record<string, Record<string, { sigma: number; n: number }>> | null;
  evMonitor?: EvMonitor;
  recent: RecentRow[];
}

const METRIC_LABELS: Record<string, string> = {
  temperature_high: "High temp",
  temperature_low: "Low temp",
  precipitation: "Precipitation",
  snowfall: "Snowfall",
  unknown: "Other",
};

export default function StatsPage() {
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cityFilter, setCityFilter] = useState("");

  // Refetches on city change; keeps the previous data rendered while the
  // filtered "recently graded" list loads (spinner only on first load).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = cityFilter
          ? `/api/stats?city=${encodeURIComponent(cityFilter)}`
          : "/api/stats";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Failed to load stats (${res.status})`);
        }
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load stats");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cityFilter]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-kalshi-border bg-kalshi-surface/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1200px] mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-kalshi-text leading-tight">
              Prediction Accuracy
            </h1>
            <p className="text-xs text-kalshi-muted">
              Graded against actual Kalshi settlements
            </p>
          </div>
          <a
            href="/weather"
            className="text-sm text-kalshi-muted hover:text-kalshi-orange font-medium transition-colors"
          >
            ← Dashboard
          </a>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-6 py-6 space-y-8">
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-10 h-10 border-3 border-kalshi-orange border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-kalshi-muted">Loading accuracy stats...</p>
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl bg-kalshi-red/10 border border-kalshi-red/30">
            <p className="text-sm text-kalshi-red font-medium">{error}</p>
          </div>
        )}

        {data && data.charts && <BotPerformanceSection charts={data.charts} />}

        {data?.evMonitor && <EvMonitorTable monitor={data.evMonitor} />}

        {data && data.overall.count === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <p className="text-lg font-semibold text-kalshi-text">No graded predictions yet</p>
            <p className="text-sm text-kalshi-muted max-w-md">
              Predictions are snapshotted hourly and graded once markets settle.
              Keep the app running and check back after the first daily markets close.
            </p>
          </div>
        )}

        {data && data.overall.count > 0 && (
          <>
            {/* Overall stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                label="Graded markets"
                value={String(data.overall.count)}
              />
              <StatCard
                label="Hit rate"
                value={`${(data.overall.hitRate * 100).toFixed(1)}%`}
                hint="Predicted side (>50%) matched the settlement"
              />
              <StatCard
                label="Brier score"
                value={data.overall.brier.toFixed(3)}
                hint="Lower is better; 0.25 = coin flip"
                good={
                  data.overall.marketBrier !== null &&
                  data.overall.brier < data.overall.marketBrier
                }
              />
              <StatCard
                label="Market Brier"
                value={data.overall.marketBrier?.toFixed(3) ?? "—"}
                hint="Kalshi prices graded the same way — are we beating the market?"
              />
            </div>

            {data.forecastMae !== null && (
              <p className="text-xs text-kalshi-muted">
                Forecast error (MAE): {" "}
                <span className="text-kalshi-text font-semibold">
                  {data.forecastMae.toFixed(1)}
                </span>{" "}
                across {data.forecastMaeCount} events with numeric settlement values.
              </p>
            )}

            {data.charts && <ModelAccuracyCharts charts={data.charts} />}

            {/* Breakdowns */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <BreakdownTable
                title="By lead time (days out)"
                groups={data.byLead}
                keyLabel={(k) => k}
              />
              <BreakdownTable
                title="By metric"
                groups={data.byMetric}
                keyLabel={(k) => METRIC_LABELS[k] ?? k}
              />
              <BreakdownTable
                title="By city"
                groups={data.byCity.slice(0, 12)}
                keyLabel={(k) => CITY_MAP[k]?.label ?? k}
              />
            </div>

            {/* Calibration table */}
            {data.calibration && Object.keys(data.calibration).length > 0 && (
              <div>
                <h2 className="text-sm font-bold text-kalshi-text mb-2">
                  Calibrated sigma (empirical forecast error)
                </h2>
                <div className="bg-kalshi-surface border border-kalshi-border rounded-xl p-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-kalshi-muted text-left">
                        <th className="font-medium pb-1">Metric</th>
                        {["0", "1", "2", "3-4", "5-7", "8+"].map((b) => (
                          <th key={b} className="font-medium pb-1 text-right">{b}d</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(data.calibration).map(([metric, buckets]) => (
                        <tr key={metric} className="text-kalshi-text border-t border-kalshi-border">
                          <td className="py-1">{METRIC_LABELS[metric] ?? metric}</td>
                          {["0", "1", "2", "3-4", "5-7", "8+"].map((b) => {
                            const c = buckets[b];
                            return (
                              <td key={b} className="py-1 text-right">
                                {c ? (
                                  <span className={c.n >= 30 ? "text-kalshi-green" : "text-kalshi-muted"}>
                                    ±{c.sigma.toFixed(1)} <span className="text-[9px]">(n={c.n})</span>
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-kalshi-muted mt-2">
                    Green buckets (n ≥ 30) actively replace the default sigma table in the predictor.
                  </p>
                </div>
              </div>
            )}

            {/* Recent resolved predictions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-bold text-kalshi-text">
                  Recently graded ({data.recent.length})
                </h2>
                <select
                  value={cityFilter}
                  onChange={(e) => setCityFilter(e.target.value)}
                  className="bg-black/30 border border-kalshi-border rounded-lg px-2 py-1 text-xs text-kalshi-text focus:outline-none focus:border-kalshi-orange transition-colors"
                >
                  <option value="">All cities</option>
                  {data.byCity.map((g) => (
                    <option key={g.key} value={g.key}>
                      {CITY_MAP[g.key]?.label ?? g.key}
                    </option>
                  ))}
                </select>
              </div>
              <div className="bg-kalshi-surface border border-kalshi-border rounded-xl overflow-x-auto">
                {data.recent.length === 0 ? (
                  <p className="p-4 text-xs text-kalshi-muted">
                    No graded markets for this city yet.
                  </p>
                ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-kalshi-muted text-left border-b border-kalshi-border">
                      <th className="font-medium p-2">Market</th>
                      <th className="font-medium p-2 text-right">FC prob</th>
                      <th className="font-medium p-2 text-right">MK prob</th>
                      <th className="font-medium p-2 text-center">Result</th>
                      <th className="font-medium p-2 text-right">Forecast</th>
                      <th className="font-medium p-2 text-right">Actual</th>
                      <th className="font-medium p-2 text-center">Correct?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => {
                      const outcome = r.result === "yes" ? 1 : 0;
                      const correct = (r.predictedProb > 0.5 ? 1 : 0) === outcome;
                      return (
                        <tr key={r.marketTicker} className="border-b border-kalshi-border/50 text-kalshi-text">
                          <td className="p-2 max-w-[320px]">
                            <span className="block truncate" title={r.marketTicker}>
                              {r.title ?? r.marketTicker}
                            </span>
                            <span className="text-[10px] text-kalshi-muted">
                              {r.marketTicker}
                              {r.targetDate ? ` · ${r.targetDate}` : ""}
                            </span>
                          </td>
                          <td className="p-2 text-right">{Math.round(r.predictedProb * 100)}%</td>
                          <td className="p-2 text-right">
                            {r.marketProb !== null ? `${Math.round(r.marketProb * 100)}%` : "—"}
                          </td>
                          <td className="p-2 text-center">
                            <span className={r.result === "yes" ? "text-kalshi-green font-bold" : "text-kalshi-red font-bold"}>
                              {r.result.toUpperCase()}
                            </span>
                          </td>
                          <td className="p-2 text-right">{r.forecastValue ?? "—"}</td>
                          <td className="p-2 text-right">{r.actualValue ?? "—"}</td>
                          <td className="p-2 text-center">
                            {correct ? (
                              <span className="text-kalshi-green">✓</span>
                            ) : (
                              <span className="text-kalshi-red">✗</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  good,
}: {
  label: string;
  value: string;
  hint?: string;
  good?: boolean;
}) {
  return (
    <div className="bg-kalshi-surface border border-kalshi-border rounded-xl p-4" title={hint}>
      <p className="text-[10px] text-kalshi-muted uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${good ? "text-kalshi-green" : "text-kalshi-text"}`}>
        {value}
      </p>
    </div>
  );
}

function BreakdownTable({
  title,
  groups,
  keyLabel,
}: {
  title: string;
  groups: StatsGroup[];
  keyLabel: (key: string) => string;
}) {
  if (groups.length === 0) return null;
  return (
    <div>
      <h2 className="text-sm font-bold text-kalshi-text mb-2">{title}</h2>
      <div className="bg-kalshi-surface border border-kalshi-border rounded-xl p-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-kalshi-muted text-left">
              <th className="font-medium pb-1"></th>
              <th className="font-medium pb-1 text-right">N</th>
              <th className="font-medium pb-1 text-right">Hit</th>
              <th className="font-medium pb-1 text-right">Brier</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="text-kalshi-text border-t border-kalshi-border/50">
                <td className="py-1">{keyLabel(g.key)}</td>
                <td className="py-1 text-right">{g.count}</td>
                <td className="py-1 text-right">{(g.hitRate * 100).toFixed(0)}%</td>
                <td className="py-1 text-right">{g.brier.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
