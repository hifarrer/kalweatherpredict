import { SortMode } from "@/lib/kalshi";

interface SortControlsProps {
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
  eventCount: number;
}

const SORT_OPTIONS: { value: SortMode; label: string; tooltip?: string }[] = [
  {
    value: "trending",
    label: "Trending",
    tooltip: "Approximated by 24-hour trading volume (highest activity first)",
  },
  { value: "volume", label: "Volume", tooltip: "Sorted by total all-time volume" },
  { value: "expiration", label: "Expiration", tooltip: "Sorted by soonest close time" },
  {
    value: "opportunity",
    label: "Opportunity",
    tooltip: "Forecast says likely YES but market price is low — potential value bets",
  },
];

export default function SortControls({ sort, onSortChange, eventCount }: SortControlsProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
      <div className="flex items-center gap-2">
        <span className="text-sm text-kalshi-muted mr-2">Sort by:</span>
        <div className="inline-flex rounded-lg border border-kalshi-border bg-kalshi-surface overflow-hidden">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onSortChange(opt.value)}
              title={opt.tooltip}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                sort === opt.value
                  ? "bg-kalshi-orange text-white"
                  : "text-kalshi-muted hover:text-kalshi-text hover:bg-white/5"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="text-sm text-kalshi-muted">
        <span className="font-semibold text-kalshi-text">{eventCount}</span> weather events
      </div>
    </div>
  );
}
