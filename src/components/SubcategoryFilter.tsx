import { WeatherMetric } from "@/types";

export type SubcategoryFilterValue = "all" | WeatherMetric;

interface SubcategoryFilterProps {
  value: SubcategoryFilterValue;
  onChange: (value: SubcategoryFilterValue) => void;
  counts: Record<string, number>;
}

const FILTER_OPTIONS: {
  value: SubcategoryFilterValue;
  label: string;
  icon: string;
}[] = [
  { value: "all", label: "All", icon: "" },
  { value: "temperature_high", label: "High Temp", icon: "🌡" },
  { value: "temperature_low", label: "Low Temp", icon: "🌙" },
  { value: "precipitation", label: "Rain", icon: "🌧" },
  { value: "snowfall", label: "Snow", icon: "❄" },
];

export default function SubcategoryFilter({
  value,
  onChange,
  counts,
}: SubcategoryFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-kalshi-muted mr-1">Filter:</span>
      {FILTER_OPTIONS.map((opt) => {
        const count = opt.value === "all"
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : counts[opt.value] ?? 0;
        // Hide categories with zero events (except "all")
        if (opt.value !== "all" && count === 0) return null;

        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
              isActive
                ? "bg-kalshi-orange text-white border-kalshi-orange"
                : "bg-kalshi-surface text-kalshi-muted border-kalshi-border hover:text-kalshi-text hover:border-white/20"
            }`}
          >
            {opt.icon && <span className="text-sm">{opt.icon}</span>}
            {opt.label}
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                isActive
                  ? "bg-white/20 text-white"
                  : "bg-white/5 text-kalshi-muted"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
