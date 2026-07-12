"use client";

import { useCallback, useEffect, useState } from "react";
import Header from "@/components/Header";
import { CITY_MAP } from "@/lib/cities";

type Outcome = "won" | "lost" | "pending" | "none";

interface HistoryRow {
  id: number;
  ticker: string;
  eventTicker: string;
  eventTitle: string | null;
  marketTitle: string | null;
  cityCode: string | null;
  side: string;
  count: number;
  fillCount: number;
  avgFillPriceCents: number | null;
  costCents: number;
  feesCents: number;
  status: string;
  outcome: Outcome;
  actualValue: number | null;
  pnlCents: number | null;
  fromSuggestion: boolean;
  suggestionWinProb: number | null;
  suggestionEv: number | null;
  suggestionKind: string | null;
  createdAt: string;
  settledAt: string | null;
}

interface HistoryData {
  orders: HistoryRow[];
  summary: {
    totalOrders: number;
    filledOrders: number;
    totalStakedCents: number;
    totalFeesCents: number;
    realizedPnlCents: number;
    wins: number;
    losses: number;
    pending: number;
    winRate: number | null;
  };
}

const OUTCOME_STYLES: Record<Outcome, { label: string; cls: string }> = {
  won: { label: "WON", cls: "bg-kalshi-green/15 text-kalshi-green" },
  lost: { label: "LOST", cls: "bg-kalshi-red/15 text-kalshi-red" },
  pending: { label: "PENDING", cls: "bg-white/5 text-kalshi-muted" },
  none: { label: "—", cls: "text-kalshi-muted" },
};

export default function HistoryPage() {
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to load history (${res.status})`);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const s = data?.summary;
  const pnlPositive = (s?.realizedPnlCents ?? 0) >= 0;

  return (
    <div className="min-h-screen">
      <Header onRefresh={load} loading={loading} />

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-kalshi-text">Order History</h1>
          <p className="text-xs text-kalshi-muted">
            Every order placed through this platform, graded against Kalshi settlements.
            P&amp;L is net of fees and based on actual fills.
          </p>
        </div>

        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Stat label="Orders" value={`${s.filledOrders} filled / ${s.totalOrders}`} />
            <Stat label="Total staked" value={`$${(s.totalStakedCents / 100).toFixed(2)}`} />
            <Stat
              label="Realized P&L"
              value={`${pnlPositive ? "+" : "−"}$${(Math.abs(s.realizedPnlCents) / 100).toFixed(2)}`}
              valueCls={pnlPositive ? "text-kalshi-green" : "text-kalshi-red"}
            />
            <Stat
              label="Win rate"
              value={
                s.winRate !== null
                  ? `${(s.winRate * 100).toFixed(0)}% (${s.wins}W / ${s.losses}L)`
                  : "—"
              }
            />
            <Stat label="Pending" value={String(s.pending)} />
          </div>
        )}

        {loading && !data ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-10 h-10 border-3 border-kalshi-orange border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-kalshi-muted">Loading order history...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl bg-kalshi-red/10 border border-kalshi-red/30">
            <p className="text-sm text-kalshi-red font-medium">{error}</p>
          </div>
        ) : data && data.orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
            <p className="text-lg font-semibold text-kalshi-text">No orders placed yet</p>
            <p className="text-sm text-kalshi-muted max-w-md">
              Orders placed through the trade button appear here with their
              settlement outcome once markets resolve.
            </p>
          </div>
        ) : data ? (
          <div className="bg-kalshi-surface border border-kalshi-border rounded-xl overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-kalshi-muted text-left border-b border-kalshi-border">
                  <th className="font-semibold p-3">Market</th>
                  <th className="font-semibold p-3">City</th>
                  <th className="font-semibold p-3">Side</th>
                  <th className="font-semibold p-3 text-right">Filled</th>
                  <th className="font-semibold p-3 text-right">Price</th>
                  <th className="font-semibold p-3 text-right">Cost</th>
                  <th className="font-semibold p-3 text-right">Fees</th>
                  <th className="font-semibold p-3">Source</th>
                  <th className="font-semibold p-3 text-center">Outcome</th>
                  <th className="font-semibold p-3 text-right" title="Net of fees">P&L</th>
                  <th className="font-semibold p-3 text-right">Placed</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((r) => {
                  const o = OUTCOME_STYLES[r.outcome];
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-kalshi-border/50 last:border-0 text-kalshi-text hover:bg-white/[0.02]"
                    >
                      <td className="p-3 max-w-[280px]">
                        <span className="block truncate" title={r.eventTitle ?? r.ticker}>
                          {r.eventTitle ?? r.ticker}
                          {r.marketTitle && (
                            <span className="text-kalshi-muted"> · {r.marketTitle}</span>
                          )}
                        </span>
                        <span className="text-[10px] text-kalshi-muted">{r.ticker}</span>
                      </td>
                      <td className="p-3 text-kalshi-muted">
                        {r.cityCode ? (CITY_MAP[r.cityCode]?.label ?? r.cityCode) : "—"}
                      </td>
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
                      <td className="p-3 text-right">
                        {r.fillCount}/{r.count}
                      </td>
                      <td className="p-3 text-right">
                        {r.avgFillPriceCents !== null ? `${r.avgFillPriceCents}¢` : "—"}
                      </td>
                      <td className="p-3 text-right">${(r.costCents / 100).toFixed(2)}</td>
                      <td className="p-3 text-right text-kalshi-muted">
                        ${(r.feesCents / 100).toFixed(2)}
                      </td>
                      <td className="p-3">
                        {r.fromSuggestion ? (
                          <span
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-purple-500/15 text-purple-300"
                            title={
                              r.suggestionWinProb !== null
                                ? `AI suggested: ${Math.round(r.suggestionWinProb * 100)}% win, EV ${
                                    r.suggestionEv !== null
                                      ? `${r.suggestionEv >= 0 ? "+" : ""}${Math.round(r.suggestionEv * 100)}¢`
                                      : "—"
                                  } (${r.suggestionKind})`
                                : "Placed from an AI suggestion"
                            }
                          >
                            AI{" "}
                            {r.suggestionWinProb !== null
                              ? `${Math.round(r.suggestionWinProb * 100)}%`
                              : ""}
                          </span>
                        ) : (
                          <span className="text-[10px] text-kalshi-muted">manual</span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${o.cls}`}>
                          {o.label}
                        </span>
                        {r.status !== "executed" && r.outcome === "none" && (
                          <span className="block text-[9px] text-kalshi-muted mt-0.5">
                            {r.status}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        {r.pnlCents !== null ? (
                          <span
                            className={`font-bold ${
                              r.pnlCents >= 0 ? "text-kalshi-green" : "text-kalshi-red"
                            }`}
                          >
                            {r.pnlCents >= 0 ? "+" : "−"}$
                            {(Math.abs(r.pnlCents) / 100).toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-kalshi-muted">—</span>
                        )}
                      </td>
                      <td className="p-3 text-right text-kalshi-muted">
                        {formatDate(r.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  valueCls,
}: {
  label: string;
  value: string;
  valueCls?: string;
}) {
  return (
    <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-3">
      <p className="text-[10px] uppercase tracking-wide text-kalshi-muted">{label}</p>
      <p className={`text-lg font-bold ${valueCls ?? "text-kalshi-text"}`}>{value}</p>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
