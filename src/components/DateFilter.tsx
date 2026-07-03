import { DateFilterValue } from "@/lib/eventDate";

interface DateFilterProps {
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
  counts: Record<DateFilterValue, number>;
}

const FILTER_OPTIONS: { value: DateFilterValue; label: string; icon: string }[] =
  [
    { value: "all", label: "All Dates", icon: "📅" },
    { value: "today", label: "Today", icon: "☀️" },
    { value: "tomorrow", label: "Tomorrow", icon: "➡️" },
    { value: "future", label: "Future", icon: "🗓️" },
  ];

export default function DateFilter({
  value,
  onChange,
  counts,
}: DateFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-kalshi-muted mr-1">Date:</span>
      {FILTER_OPTIONS.map((opt) => {
        const count = counts[opt.value] ?? 0;
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
