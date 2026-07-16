"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "@/components/Header";

/**
 * AI Automation admin page: configure the auto-trading bot, watch its open
 * positions, and audit every decision it has made.
 */

interface AutomationSettings {
  enabled: boolean;
  budgetCents: number;
  maxPerTradeCents: number;
  takeProfitMode: "profit_pct" | "capture_pct";
  takeProfitValue: number;
  stopLossEnabled: boolean;
  stopLossPct: number;
  minScore: number;
  minEv: number;
  minWinProb: number;
  obsBackedOnly: boolean;
  targetDateMode: "tomorrow_only" | "prefer_tomorrow" | "any";
  maxBuysPerRun: number;
  maxOpenPositions: number;
  minAiConfidence: number;
  minPriceCents: number;
  maxProbGap: number;
  maxDailyLossCents: number;
  excludeCities: string[];
}

interface PositionRow {
  id: number;
  ticker: string;
  eventTicker: string;
  side: string;
  count: number;
  avgCostCents: number;
  buyFeeCents: number | null;
  status: string;
  targetDate: string | null;
  openedAt: string;
  bidCents: number | null;
  unrealizedPnlCents: number | null;
  marketTitle: string | null;
}

interface ActionRow {
  id: number;
  kind: string;
  ticker: string | null;
  side: string | null;
  count: number | null;
  priceCents: number | null;
  reason: string;
  createdAt: string;
}

interface RunRow {
  id: number;
  trigger: string;
  status: string;
  balanceCents: number | null;
  deployedCents: number | null;
  candidates: number | null;
  buys: number | null;
  sells: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  actions: ActionRow[];
}

interface StatusResponse {
  settings: AutomationSettings;
  tradingConfigured: boolean;
  cronConfigured: boolean;
  balanceCents: number | null;
  deployedCents: number;
  realizedPnlCents: number;
  positions: PositionRow[];
  runs: RunRow[];
}

function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function pnlClass(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "text-kalshi-muted";
  return cents >= 0 ? "text-kalshi-green" : "text-red-400";
}

const KIND_BADGE: Record<string, string> = {
  buy: "bg-kalshi-green/15 text-kalshi-green",
  sell: "bg-kalshi-orange/15 text-kalshi-orange",
  close_settled: "bg-blue-500/15 text-blue-400",
  skip: "bg-white/5 text-kalshi-muted",
  info: "bg-white/5 text-kalshi-muted",
  error: "bg-red-500/15 text-red-400",
};

const inputCls =
  "w-full px-3 py-2 rounded-lg bg-kalshi-bg border border-kalshi-border text-kalshi-text text-sm focus:outline-none focus:border-kalshi-orange";
const labelCls = "block text-xs font-medium text-kalshi-muted mb-1";

export default function AutomationPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [form, setForm] = useState<AutomationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/automation/status", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to load (${res.status})`);
      setStatus(data);
      // Only seed the form when it has no unsaved edits
      setForm((prev) => (prev && background ? prev : data.settings));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(
    () => !!form && !!status && JSON.stringify(form) !== JSON.stringify(status.settings),
    [form, status],
  );

  const set = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/automation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setForm(data.settings);
      setStatus((prev) => (prev ? { ...prev, settings: data.settings } : prev));
      setNotice("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/automation/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Run failed");
      setNotice(
        data.status === "skipped"
          ? `Run skipped: ${data.reason ?? "already in progress"}`
          : `Run finished: ${data.buys} buys, ${data.sells} sells (${data.candidates} candidates)`,
      );
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const lastRun = status?.runs?.[0];
  const budgetUsedPct = status
    ? Math.min(100, Math.round((status.deployedCents / Math.max(1, status.settings.budgetCents)) * 100))
    : 0;

  return (
    <div className="min-h-screen bg-kalshi-bg">
      <Header onRefresh={() => load()} loading={loading} />
      <main className="max-w-[1200px] mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-kalshi-text">AI Automation</h2>
            <p className="text-sm text-kalshi-muted">
              Automatic buy/sell of suggested moves, gated by AI review and your budget
            </p>
          </div>
          <button
            onClick={runNow}
            disabled={running || !status?.tradingConfigured}
            className="px-4 py-2 rounded-lg bg-kalshi-orange hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {running ? "Running…" : "Run now"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-kalshi-green/40 bg-kalshi-green/10 px-4 py-3 text-sm text-kalshi-green">
            {notice}
          </div>
        )}

        {/* Status banner */}
        {status && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-4">
              <div className="text-xs text-kalshi-muted mb-1">Status</div>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${
                  status.settings.enabled
                    ? "bg-kalshi-green/15 text-kalshi-green"
                    : "bg-white/5 text-kalshi-muted"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    status.settings.enabled ? "bg-kalshi-green animate-pulse" : "bg-kalshi-muted"
                  }`}
                />
                {status.settings.enabled ? "Enabled" : "Disabled"}
              </span>
              {!status.tradingConfigured && (
                <div className="text-xs text-red-400 mt-1">Kalshi keys missing</div>
              )}
              {!status.cronConfigured && (
                <div className="text-xs text-red-400 mt-1">CRON_SECRET missing</div>
              )}
            </div>
            <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-4">
              <div className="text-xs text-kalshi-muted mb-1">Kalshi balance</div>
              <div className="text-lg font-bold text-kalshi-text">{dollars(status.balanceCents)}</div>
            </div>
            <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-4">
              <div className="text-xs text-kalshi-muted mb-1">
                Deployed / budget ({budgetUsedPct}%)
              </div>
              <div className="text-lg font-bold text-kalshi-text">
                {dollars(status.deployedCents)}{" "}
                <span className="text-sm font-normal text-kalshi-muted">
                  / {dollars(status.settings.budgetCents)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-kalshi-orange"
                  style={{ width: `${budgetUsedPct}%` }}
                />
              </div>
            </div>
            <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-4">
              <div className="text-xs text-kalshi-muted mb-1">Realized P&L (bot)</div>
              <div className={`text-lg font-bold ${pnlClass(status.realizedPnlCents)}`}>
                {dollars(status.realizedPnlCents)}
              </div>
            </div>
            <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-4">
              <div className="text-xs text-kalshi-muted mb-1">Last run</div>
              {lastRun ? (
                <>
                  <div className="text-sm font-semibold text-kalshi-text">
                    {new Date(lastRun.startedAt).toLocaleString()}
                  </div>
                  <div
                    className={`text-xs ${
                      lastRun.status === "ok"
                        ? "text-kalshi-green"
                        : lastRun.status === "error"
                          ? "text-red-400"
                          : "text-kalshi-muted"
                    }`}
                  >
                    {lastRun.status}
                    {lastRun.status === "ok" &&
                      ` — ${lastRun.buys ?? 0} buys, ${lastRun.sells ?? 0} sells`}
                  </div>
                </>
              ) : (
                <div className="text-sm text-kalshi-muted">Never</div>
              )}
            </div>
          </div>
        )}

        {/* Settings */}
        {form && (
          <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-6 space-y-6">
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-lg font-bold text-kalshi-text">Settings</h3>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => set("enabled", e.target.checked)}
                    className="w-4 h-4 accent-kalshi-orange"
                  />
                  <span className="text-sm font-semibold text-kalshi-text">
                    Automation enabled
                  </span>
                </label>
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  className="px-4 py-2 rounded-lg bg-kalshi-orange hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
                >
                  {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
              {/* Budget */}
              <div>
                <label className={labelCls}>Total budget ($ deployed at once)</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={form.budgetCents / 100}
                  onChange={(e) => set("budgetCents", Math.round(parseFloat(e.target.value || "0") * 100))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Max cost per transaction ($)</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={form.maxPerTradeCents / 100}
                  onChange={(e) =>
                    set("maxPerTradeCents", Math.round(parseFloat(e.target.value || "0") * 100))
                  }
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Target events</label>
                <select
                  value={form.targetDateMode}
                  onChange={(e) => set("targetDateMode", e.target.value as AutomationSettings["targetDateMode"])}
                  className={inputCls}
                >
                  <option value="prefer_tomorrow">Prefer tomorrow&apos;s events</option>
                  <option value="tomorrow_only">Tomorrow&apos;s events only</option>
                  <option value="any">Any date</option>
                </select>
              </div>

              {/* Take-profit */}
              <div>
                <label className={labelCls}>Take-profit mode</label>
                <select
                  value={form.takeProfitMode}
                  onChange={(e) => set("takeProfitMode", e.target.value as AutomationSettings["takeProfitMode"])}
                  className={inputCls}
                >
                  <option value="profit_pct">% profit over cost</option>
                  <option value="capture_pct">% of max potential profit</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Take-profit threshold (%)</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={form.takeProfitValue}
                  onChange={(e) => set("takeProfitValue", parseFloat(e.target.value || "0"))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.stopLossEnabled}
                      onChange={(e) => set("stopLossEnabled", e.target.checked)}
                      className="w-3.5 h-3.5 accent-kalshi-orange"
                    />
                    Stop-loss (% below cost)
                  </span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={form.stopLossPct}
                  disabled={!form.stopLossEnabled}
                  onChange={(e) => set("stopLossPct", parseFloat(e.target.value || "0"))}
                  className={`${inputCls} disabled:opacity-40`}
                />
              </div>

              {/* Buy filters */}
              <div>
                <label className={labelCls}>Min EV per contract (¢)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={Math.round(form.minEv * 100)}
                  onChange={(e) => set("minEv", parseFloat(e.target.value || "0") / 100)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Min win probability (%)</label>
                <input
                  type="number"
                  min={0}
                  max={99}
                  value={Math.round(form.minWinProb * 100)}
                  onChange={(e) => set("minWinProb", parseFloat(e.target.value || "0") / 100)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Min risk-adjusted score</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={form.minScore}
                  onChange={(e) => set("minScore", parseFloat(e.target.value || "0"))}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Min entry price (¢)</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={form.minPriceCents}
                  onChange={(e) => set("minPriceCents", parseInt(e.target.value || "1", 10))}
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-kalshi-muted">
                  Cheap contracts = model vs market disagreement; those lost badly
                </p>
              </div>
              <div>
                <label className={labelCls}>Max model-vs-market gap (%)</label>
                <input
                  type="number"
                  min={5}
                  max={100}
                  value={Math.round(form.maxProbGap * 100)}
                  onChange={(e) => set("maxProbGap", parseFloat(e.target.value || "0") / 100)}
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-kalshi-muted">
                  Skip buys where the model claims this much more than the market implies
                </p>
              </div>
              <div>
                <label className={labelCls}>Daily loss circuit breaker ($, 0 = off)</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.maxDailyLossCents / 100}
                  onChange={(e) =>
                    set("maxDailyLossCents", Math.round(parseFloat(e.target.value || "0") * 100))
                  }
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-kalshi-muted">
                  Buying halts for the day once 24h realized losses reach this; selling continues
                </p>
              </div>

              <div>
                <label className={labelCls}>Excluded cities (comma-separated codes)</label>
                <input
                  type="text"
                  value={(form.excludeCities ?? []).join(", ")}
                  onChange={(e) =>
                    set(
                      "excludeCities",
                      e.target.value
                        .split(",")
                        .map((c) => c.trim().toUpperCase())
                        .filter(Boolean),
                    )
                  }
                  className={inputCls}
                  placeholder="LAS, DAL, MSY"
                />
                <p className="mt-1 text-[11px] text-kalshi-muted">
                  The bot never buys these cities — persistently negative realized EV
                </p>
              </div>

              <div>
                <label className={labelCls}>Min AI review confidence (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(form.minAiConfidence * 100)}
                  onChange={(e) => set("minAiConfidence", parseFloat(e.target.value || "0") / 100)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Max buys per run</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={form.maxBuysPerRun}
                  onChange={(e) => set("maxBuysPerRun", parseInt(e.target.value || "1", 10))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Max open positions</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={form.maxOpenPositions}
                  onChange={(e) => set("maxOpenPositions", parseInt(e.target.value || "1", 10))}
                  className={inputCls}
                />
              </div>

              <div className="md:col-span-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.obsBackedOnly}
                    onChange={(e) => set("obsBackedOnly", e.target.checked)}
                    className="w-4 h-4 accent-kalshi-orange"
                  />
                  <span className="text-sm text-kalshi-text">
                    Only buy observation-backed picks
                    <span className="text-kalshi-muted">
                      {" "}
                      (same-day suggestions confirmed by official station data — safest, but skips most tomorrow events)
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Open positions */}
        <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-6">
          <h3 className="text-lg font-bold text-kalshi-text mb-4">
            Open bot positions {status ? `(${status.positions.length})` : ""}
          </h3>
          {status && status.positions.length === 0 ? (
            <p className="text-sm text-kalshi-muted">No open positions.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-kalshi-muted border-b border-kalshi-border">
                    <th className="py-2 pr-4">Market</th>
                    <th className="py-2 pr-4">Side</th>
                    <th className="py-2 pr-4">Count</th>
                    <th className="py-2 pr-4">Avg cost</th>
                    <th className="py-2 pr-4">Current bid</th>
                    <th className="py-2 pr-4">Unrealized P&L</th>
                    <th className="py-2 pr-4">Target date</th>
                    <th className="py-2">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {status?.positions.map((p) => (
                    <tr key={p.id} className="border-b border-kalshi-border/50">
                      <td className="py-2 pr-4">
                        <div className="text-kalshi-text font-medium">
                          {p.marketTitle ?? p.ticker}
                        </div>
                        <div className="text-xs text-kalshi-muted">{p.ticker}</div>
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                            p.side === "yes"
                              ? "bg-kalshi-green/15 text-kalshi-green"
                              : "bg-red-500/15 text-red-400"
                          }`}
                        >
                          {p.side.toUpperCase()}
                        </span>
                        {p.status === "closing" && (
                          <span className="ml-1 text-xs text-kalshi-muted">closing…</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-kalshi-text">{p.count}</td>
                      <td className="py-2 pr-4 text-kalshi-text">{p.avgCostCents}¢</td>
                      <td className="py-2 pr-4 text-kalshi-text">
                        {p.bidCents !== null ? `${p.bidCents}¢` : "—"}
                      </td>
                      <td className={`py-2 pr-4 font-semibold ${pnlClass(p.unrealizedPnlCents)}`}>
                        {dollars(p.unrealizedPnlCents)}
                      </td>
                      <td className="py-2 pr-4 text-kalshi-muted">{p.targetDate ?? "—"}</td>
                      <td className="py-2 text-kalshi-muted">
                        {new Date(p.openedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Activity log */}
        <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-6">
          <h3 className="text-lg font-bold text-kalshi-text mb-4">Activity log</h3>
          {status && status.runs.length === 0 ? (
            <p className="text-sm text-kalshi-muted">
              No runs yet. Hit &quot;Run now&quot; or point your cron service at the endpoint below.
            </p>
          ) : (
            <div className="space-y-2">
              {status?.runs.map((run) => (
                <div key={run.id} className="rounded-lg border border-kalshi-border/60">
                  <button
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${
                          run.status === "ok"
                            ? "bg-kalshi-green/15 text-kalshi-green"
                            : run.status === "error"
                              ? "bg-red-500/15 text-red-400"
                              : run.status === "running"
                                ? "bg-kalshi-orange/15 text-kalshi-orange"
                                : "bg-white/5 text-kalshi-muted"
                        }`}
                      >
                        {run.status}
                      </span>
                      <span className="text-sm text-kalshi-text truncate">
                        {new Date(run.startedAt).toLocaleString()}
                        <span className="text-kalshi-muted"> · {run.trigger}</span>
                      </span>
                    </div>
                    <span className="text-xs text-kalshi-muted shrink-0">
                      {run.error
                        ? run.error.slice(0, 60)
                        : `${run.buys ?? 0} buys · ${run.sells ?? 0} sells · ${run.actions.length} actions`}
                    </span>
                  </button>
                  {expandedRun === run.id && (
                    <div className="border-t border-kalshi-border/60 px-4 py-3 space-y-1.5">
                      {run.actions.length === 0 && (
                        <p className="text-xs text-kalshi-muted">No actions recorded.</p>
                      )}
                      {[...run.actions].reverse().map((a) => (
                        <div key={a.id} className="flex items-start gap-2 text-xs">
                          <span
                            className={`px-1.5 py-0.5 rounded font-semibold shrink-0 ${KIND_BADGE[a.kind] ?? KIND_BADGE.info}`}
                          >
                            {a.kind}
                          </span>
                          {a.ticker && (
                            <span className="text-kalshi-text font-mono shrink-0">
                              {a.ticker}
                              {a.side ? ` ${a.side.toUpperCase()}` : ""}
                            </span>
                          )}
                          <span className="text-kalshi-muted">{a.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cron setup hint */}
        <div className="rounded-lg border border-kalshi-border bg-kalshi-surface p-6">
          <h3 className="text-lg font-bold text-kalshi-text mb-2">External cron setup</h3>
          <p className="text-sm text-kalshi-muted mb-3">
            Point your cron service (e.g. cron-job.org) at this URL every 5–10 minutes with a
            GET request. Replace <code className="text-kalshi-orange">&lt;CRON_SECRET&gt;</code>{" "}
            with the value from your server&apos;s environment — it is never shown here.
          </p>
          <code className="block rounded-lg bg-kalshi-bg border border-kalshi-border px-4 py-3 text-sm text-kalshi-text overflow-x-auto">
            GET {origin}/api/cron/auto-trade?secret=&lt;CRON_SECRET&gt;
          </code>
          <p className="text-xs text-kalshi-muted mt-3">
            Runs are safe to overlap — a second hit while one is in progress returns
            &quot;skipped&quot;. While the master toggle is off, cron hits do nothing.
          </p>
        </div>
      </main>
    </div>
  );
}
