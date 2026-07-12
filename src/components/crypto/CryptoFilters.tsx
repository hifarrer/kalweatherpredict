"use client";

import { CRYPTO_ASSETS } from "@/lib/crypto/assets";

/**
 * Dashboard filters for the crypto section: asset chips, minimum 24h volume,
 * settlement-horizon chips, and sort mode.
 */

export type CryptoHorizon = "all" | "1h" | "today" | "later";
export type CryptoSort = "expiration" | "volume" | "edge";

export interface CryptoFilterState {
  asset: string | "all";
  minVolume: number;
  horizon: CryptoHorizon;
  sort: CryptoSort;
}

export const DEFAULT_CRYPTO_FILTERS: CryptoFilterState = {
  asset: "all",
  minVolume: 0,
  horizon: "all",
  sort: "expiration",
};

const VOLUME_OPTIONS = [
  { value: 0, label: "Any volume" },
  { value: 1_000, label: "≥ 1K (24h)" },
  { value: 10_000, label: "≥ 10K (24h)" },
  { value: 100_000, label: "≥ 100K (24h)" },
];

const HORIZON_OPTIONS: { value: CryptoHorizon; label: string }[] = [
  { value: "all", label: "All" },
  { value: "1h", label: "Closing ≤ 1h" },
  { value: "today", label: "Today" },
  { value: "later", label: "Later" },
];

const SORT_OPTIONS: { value: CryptoSort; label: string }[] = [
  { value: "expiration", label: "Expiration" },
  { value: "volume", label: "Volume" },
  { value: "edge", label: "Edge" },
];

interface CryptoFiltersProps {
  filters: CryptoFilterState;
  counts: { all: number; byAsset: Record<string, number> };
  onChange: (next: CryptoFilterState) => void;
}

const chipCls = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
    active
      ? "bg-kalshi-orange text-white"
      : "bg-white/5 text-kalshi-muted hover:text-kalshi-text"
  }`;

export default function CryptoFilters({ filters, counts, onChange }: CryptoFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {/* Asset chips */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-kalshi-muted font-medium">Crypto:</span>
        <button
          className={chipCls(filters.asset === "all")}
          onClick={() => onChange({ ...filters, asset: "all" })}
        >
          All <span className="opacity-60">{counts.all}</span>
        </button>
        {CRYPTO_ASSETS.map((a) => (
          <button
            key={a.code}
            className={chipCls(filters.asset === a.code)}
            onClick={() => onChange({ ...filters, asset: a.code })}
          >
            {a.code} <span className="opacity-60">{counts.byAsset[a.code] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-kalshi-muted font-medium">Volume:</span>
        <select
          value={filters.minVolume}
          onChange={(e) => onChange({ ...filters, minVolume: Number(e.target.value) })}
          className="bg-kalshi-surface border border-kalshi-border rounded-lg px-2 py-1.5 text-xs text-kalshi-text"
        >
          {VOLUME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Horizon */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-kalshi-muted font-medium">Closes:</span>
        {HORIZON_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={chipCls(filters.horizon === o.value)}
            onClick={() => onChange({ ...filters, horizon: o.value })}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* Sort */}
      <div className="flex items-center gap-2 ml-auto">
        <span className="text-xs text-kalshi-muted font-medium">Sort:</span>
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={chipCls(filters.sort === o.value)}
            onClick={() => onChange({ ...filters, sort: o.value })}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Apply the horizon filter to an event's earliest close time. */
export function matchesHorizon(earliestClose: string, horizon: CryptoHorizon): boolean {
  if (horizon === "all") return true;
  const closeMs = new Date(earliestClose).getTime();
  if (!Number.isFinite(closeMs)) return false;
  const hours = (closeMs - Date.now()) / 3_600_000;
  // "today" = closes before the next ET midnight
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const midnight = new Date(etNow);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - etNow.getTime();
  switch (horizon) {
    case "1h":
      return hours <= 1;
    case "today":
      return closeMs - Date.now() <= msUntilMidnight;
    case "later":
      return closeMs - Date.now() > msUntilMidnight;
  }
}
