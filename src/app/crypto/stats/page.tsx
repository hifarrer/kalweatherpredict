"use client";

import { useEffect, useState } from "react";
import Header from "@/components/Header";
import type { BotChartsPayload, EvMonitor } from "@/lib/botStats";
import {
  BotPerformanceSection,
  ModelAccuracyCharts,
} from "@/components/charts/BotPerformanceSection";
import { EvMonitorTable } from "@/components/charts/EvMonitorTable";

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
  asset: string | null;
  targetDate: string | null;
  tauHours: number | null;
  predictedProb: number;
  marketProb: number | null;
  result: string;
  forecastValue: number | null;
  actualValue: number | null;
}

interface StatsData {
  charts: BotChartsPayload;
  overall: StatsGroup;
  byAsset: StatsGroup[];
  byTauBucket: StatsGroup[];
  calibration: Record<string, { m: number; n: number }> | null;
  evMonitor?: EvMonitor;
  recent: RecentRow[];
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function GroupTable({ title, groups }: { title: string; groups: StatsGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
      <h3 className="text-sm font-bold text-kalshi-text mb-3">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-kalshi-muted border-b border-kalshi-border">
            <th className="py-1.5 pr-3">Group</th>
            <th className="py-1.5 pr-3">Graded</th>
            <th className="py-1.5 pr-3">Hit rate</th>
            <th className="py-1.5 pr-3" title="Mean squared error of P(YES) — lower is better">
              Brier
            </th>
            <th className="py-1.5" title="Brier of the market price, for comparison">
              Market Brier
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-b border-kalshi-border/40">
              <td className="py-1.5 pr-3 font-semibold text-kalshi-text">{g.key}</td>
              <td className="py-1.5 pr-3 text-kalshi-muted">{g.count}</td>
              <td className="py-1.5 pr-3 text-kalshi-text">{pct(g.hitRate)}</td>
              <td
                className={`py-1.5 pr-3 font-semibold ${
                  g.marketBrier !== null && g.brier < g.marketBrier
                    ? "text-kalshi-green"
                    : "text-kalshi-text"
                }`}
              >
                {g.brier.toFixed(4)}
              </td>
              <td className="py-1.5 text-kalshi-muted">
                {g.marketBrier !== null ? g.marketBrier.toFixed(4) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CryptoStatsPage() {
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/crypto/stats", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `Failed to load stats (${res.status})`);
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load stats");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen">
      <Header loading={loading} />
      <main className="max-w-[1200px] mx-auto px-6 py-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-kalshi-text">Crypto Prediction Accuracy</h1>
          <p className="text-xs text-kalshi-muted">
            The diffusion model&apos;s probabilities graded against actual Kalshi settlements
          </p>
        </div>

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
          <p className="text-sm text-kalshi-muted py-12 text-center">
            Nothing graded yet — snapshots accumulate as hourly crypto markets settle
            (typically within a few hours of enabling the section).
          </p>
        )}

        {data && data.overall.count > 0 && (
          <>
            {/* Overall tiles */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
                <div className="text-xs text-kalshi-muted mb-1">Graded markets</div>
                <div className="text-2xl font-bold text-kalshi-text">{data.overall.count}</div>
              </div>
              <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
                <div className="text-xs text-kalshi-muted mb-1">Hit rate</div>
                <div className="text-2xl font-bold text-kalshi-text">
                  {pct(data.overall.hitRate)}
                </div>
              </div>
              <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
                <div className="text-xs text-kalshi-muted mb-1">Model Brier</div>
                <div
                  className={`text-2xl font-bold ${
                    data.overall.marketBrier !== null &&
                    data.overall.brier < data.overall.marketBrier
                      ? "text-kalshi-green"
                      : "text-kalshi-text"
                  }`}
                >
                  {data.overall.brier.toFixed(4)}
                </div>
              </div>
              <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
                <div className="text-xs text-kalshi-muted mb-1">Market Brier</div>
                <div className="text-2xl font-bold text-kalshi-muted">
                  {data.overall.marketBrier !== null
                    ? data.overall.marketBrier.toFixed(4)
                    : "—"}
                </div>
              </div>
            </div>

            {data.charts && <ModelAccuracyCharts charts={data.charts} />}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <GroupTable title="By asset" groups={data.byAsset} />
              <GroupTable title="By time to settlement" groups={data.byTauBucket} />
            </div>

            {/* σ calibration */}
            {data.calibration && Object.keys(data.calibration).length > 0 && (
              <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
                <h3 className="text-sm font-bold text-kalshi-text mb-1">
                  Volatility calibration
                </h3>
                <p className="text-[11px] text-kalshi-muted mb-3">
                  RMS of standardized settlement outcomes per horizon bucket. 1.00 means the
                  model&apos;s σ is right; above 1 means volatility is being underestimated
                  (multiplier applied automatically once a bucket has 30+ samples).
                </p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-kalshi-muted border-b border-kalshi-border">
                      <th className="py-1.5 pr-3">τ bucket</th>
                      <th className="py-1.5 pr-3">Multiplier</th>
                      <th className="py-1.5">Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.calibration).map(([bucket, c]) => (
                      <tr key={bucket} className="border-b border-kalshi-border/40">
                        <td className="py-1.5 pr-3 font-semibold text-kalshi-text">{bucket}</td>
                        <td className="py-1.5 pr-3 text-kalshi-text">×{c.m.toFixed(2)}</td>
                        <td className="py-1.5 text-kalshi-muted">
                          {c.n}
                          {c.n < 30 ? " (needs 30 to apply)" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recently graded */}
            <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
              <h3 className="text-sm font-bold text-kalshi-text mb-3">Recently graded</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-kalshi-muted border-b border-kalshi-border">
                      <th className="py-1.5 pr-3">Asset</th>
                      <th className="py-1.5 pr-3">Market</th>
                      <th className="py-1.5 pr-3">τ at snapshot</th>
                      <th className="py-1.5 pr-3">Model P(YES)</th>
                      <th className="py-1.5 pr-3">Market</th>
                      <th className="py-1.5 pr-3">Result</th>
                      <th className="py-1.5 pr-3">Spot → settle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => {
                      const hit = (r.predictedProb > 0.5 ? "yes" : "no") === r.result;
                      return (
                        <tr key={r.marketTicker} className="border-b border-kalshi-border/40">
                          <td className="py-1.5 pr-3 font-bold text-kalshi-orange">
                            {r.asset ?? "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-kalshi-text">
                            <div className="max-w-[280px] truncate" title={r.marketTicker}>
                              {r.title ?? r.marketTicker}
                            </div>
                          </td>
                          <td className="py-1.5 pr-3 text-kalshi-muted">
                            {r.tauHours !== null
                              ? r.tauHours < 1.5
                                ? `${Math.round(r.tauHours * 60)}m`
                                : `${r.tauHours.toFixed(1)}h`
                              : "—"}
                          </td>
                          <td
                            className={`py-1.5 pr-3 font-semibold ${
                              hit ? "text-kalshi-green" : "text-kalshi-red"
                            }`}
                          >
                            {pct(r.predictedProb)}
                          </td>
                          <td className="py-1.5 pr-3 text-kalshi-muted">
                            {r.marketProb !== null ? pct(r.marketProb) : "—"}
                          </td>
                          <td className="py-1.5 pr-3 font-bold uppercase text-kalshi-text">
                            {r.result}
                          </td>
                          <td className="py-1.5 pr-3 text-kalshi-muted">
                            {r.forecastValue !== null && r.actualValue !== null
                              ? `$${Math.round(r.forecastValue).toLocaleString()} → $${Math.round(
                                  r.actualValue,
                                ).toLocaleString()}`
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
