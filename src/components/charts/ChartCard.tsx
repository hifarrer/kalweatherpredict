import { ReactNode } from "react";

/** Card wrapper for a single chart, matching the stats-page card idiom. */
export function ChartCard({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When set, rendered as a muted empty state instead of the chart. */
  empty?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-kalshi-border bg-kalshi-surface p-4">
      <h3 className="text-sm font-semibold text-kalshi-text">{title}</h3>
      {subtitle && (
        <p className="text-[11px] text-kalshi-muted mt-0.5">{subtitle}</p>
      )}
      {empty ? (
        <div className="flex items-center justify-center h-40 text-xs text-kalshi-muted text-center px-6">
          {empty}
        </div>
      ) : (
        <div className="mt-3">{children}</div>
      )}
    </div>
  );
}

export interface LegendItem {
  name: string;
  color: string;
  /** rect for bars/areas, line for lines, dual for sign-colored bars */
  kind: "rect" | "line" | "dual";
  color2?: string; // second color for dual swatches
}

/** Legend row — required whenever a chart has two or more series. */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
      {items.map((it) => (
        <span key={it.name} className="flex items-center gap-1.5">
          {it.kind === "line" ? (
            <span
              className="inline-block w-3 rounded-full"
              style={{ height: 2, backgroundColor: it.color }}
            />
          ) : it.kind === "dual" ? (
            <span className="inline-flex">
              <span
                className="inline-block w-1.5 h-2.5 rounded-l-sm"
                style={{ backgroundColor: it.color }}
              />
              <span
                className="inline-block w-1.5 h-2.5 rounded-r-sm"
                style={{ backgroundColor: it.color2 ?? it.color }}
              />
            </span>
          ) : (
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: it.color }}
            />
          )}
          <span className="text-[11px] text-kalshi-muted">{it.name}</span>
        </span>
      ))}
    </div>
  );
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string; // line-key color for series rows
  strong?: boolean; // highlight the value (default true)
}

/**
 * Shared tooltip: values lead (bright, semibold), labels follow (muted), and
 * series rows key themselves with a short stroke of the series color.
 * Positioned by the caller inside a `relative` wrapper.
 */
export function TooltipBox({
  heading,
  rows,
  style,
}: {
  heading: string;
  rows: TooltipRow[];
  style: React.CSSProperties;
}) {
  return (
    <div
      className="absolute z-10 pointer-events-none rounded-lg border border-kalshi-border bg-[#1c1c24] px-3 py-2 shadow-xl min-w-[130px]"
      style={style}
    >
      <p className="text-[10px] text-kalshi-muted mb-1">{heading}</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-3 leading-5">
          <span className="flex items-center gap-1.5 min-w-0">
            {r.color && (
              <span
                className="inline-block w-2.5 shrink-0 rounded-full"
                style={{ height: 2, backgroundColor: r.color }}
              />
            )}
            <span className="text-[11px] text-kalshi-muted truncate">
              {r.label}
            </span>
          </span>
          <span
            className={
              r.strong === false
                ? "text-[11px] text-kalshi-muted"
                : "text-[11px] font-semibold text-kalshi-text tabular-nums"
            }
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}
