"use client";

import type { EvMonitor, EvMonitorRow } from "@/lib/botStats";

/**
 * The miscalibration alarm: predicted vs realized EV per contract, weekly and
 * (weather) per city over the trailing 30 days. A persistent gap between the
 * two columns means the scorer is fooling itself — the weather bot spent
 * weeks predicting +25¢ while realizing +0.7¢ before this table existed.
 */
export function EvMonitorTable({ monitor }: { monitor: EvMonitor }) {
  if (!monitor || monitor.weekly.length === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-kalshi-text">Predicted vs realized EV</h2>
        <p className="text-xs text-kalshi-muted">
          Graded suggestions: what the scorer expected per contract vs what settled. A
          persistent gap = miscalibration — investigate before trusting new picks.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <EvTable title="By week" rows={monitor.weekly} keyLabel="Week of" />
        {monitor.byCity.length > 0 && (
          <EvTable title="By city (30d, worst first)" rows={monitor.byCity.slice(0, 10)} keyLabel="City" />
        )}
      </div>
    </section>
  );
}

function EvTable({ title, rows, keyLabel }: { title: string; rows: EvMonitorRow[]; keyLabel: string }) {
  return (
    <div className="rounded-xl border border-kalshi-border bg-kalshi-surface/50 p-4">
      <h3 className="text-sm font-semibold text-kalshi-text mb-2">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-kalshi-muted text-left">
            <th className="py-1 pr-2 font-medium">{keyLabel}</th>
            <th className="py-1 pr-2 font-medium text-right">n</th>
            <th className="py-1 pr-2 font-medium text-right">Win rate</th>
            <th className="py-1 pr-2 font-medium text-right">Predicted EV</th>
            <th className="py-1 font-medium text-right">Realized EV</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const gap =
              r.avgPredictedEv !== null && r.avgRealizedEv !== null
                ? r.avgPredictedEv - r.avgRealizedEv
                : null;
            return (
              <tr key={r.key} className="border-t border-kalshi-border/50">
                <td className="py-1.5 pr-2 text-kalshi-text font-medium">{r.key}</td>
                <td className="py-1.5 pr-2 text-right text-kalshi-muted">{r.n}</td>
                <td className="py-1.5 pr-2 text-right text-kalshi-text">
                  {r.winRate !== null ? `${(100 * r.winRate).toFixed(0)}%` : "—"}
                </td>
                <td className="py-1.5 pr-2 text-right text-kalshi-text">
                  {r.avgPredictedEv !== null ? `${(100 * r.avgPredictedEv).toFixed(1)}¢` : "—"}
                </td>
                <td
                  className={`py-1.5 text-right font-medium ${
                    gap !== null && gap > 0.05
                      ? "text-kalshi-red"
                      : r.avgRealizedEv !== null && r.avgRealizedEv > 0
                        ? "text-kalshi-green"
                        : "text-kalshi-text"
                  }`}
                >
                  {r.avgRealizedEv !== null ? `${(100 * r.avgRealizedEv).toFixed(1)}¢` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
