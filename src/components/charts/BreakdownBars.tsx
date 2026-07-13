import { CHART, formatCents } from "@/components/charts/chartUtils";

export interface BreakdownRow {
  label: string;
  count: number;
  pnlCents: number;
}

/**
 * Horizontal breakdown (exit reasons): proportional count bar per row with
 * the count and net P&L alongside. Plain HTML — no hover layer needed since
 * every value is directly labeled.
 */
export function BreakdownBars({ rows }: { rows: BreakdownRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-[11px] text-kalshi-muted">
            {r.label}
          </span>
          <div className="flex-1 h-[10px]">
            <div
              className="h-full rounded-r"
              style={{
                width: `${Math.max(2, (r.count / max) * 100)}%`,
                backgroundColor: CHART.cat1,
              }}
            />
          </div>
          <span className="w-14 shrink-0 text-right text-[11px] text-kalshi-text tabular-nums">
            {r.count}
            <span className="text-kalshi-muted"> ×</span>
          </span>
          <span
            className={`w-20 shrink-0 text-right text-[11px] font-semibold tabular-nums ${
              r.pnlCents < 0
                ? "text-kalshi-red"
                : r.pnlCents > 0
                  ? "text-kalshi-green"
                  : "text-kalshi-muted"
            }`}
          >
            {formatCents(r.pnlCents)}
          </span>
        </div>
      ))}
    </div>
  );
}
