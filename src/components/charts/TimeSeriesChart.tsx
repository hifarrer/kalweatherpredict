"use client";

import { useMemo, useRef, useState } from "react";
import {
  CHART,
  linePath,
  niceTicks,
  scaleLinear,
} from "@/components/charts/chartUtils";
import { ChartLegend, TooltipBox } from "@/components/charts/ChartCard";

export interface TSeries {
  name: string;
  color: string;
  points: { x: number; y: number }[]; // ascending x
  /** ~10% opacity wash under the line */
  area?: boolean;
}

const W = 600;
const H = 230;
const M = { t: 10, r: 10, b: 22, l: 48 };

/**
 * Multi-series line chart with a crosshair hover: the hairline snaps to the
 * nearest data x and one tooltip lists every series at that x.
 */
export function TimeSeriesChart({
  series,
  xFormatter,
  yFormatter,
  yDomain,
}: {
  series: TSeries[];
  xFormatter: (x: number) => string;
  yFormatter: (y: number) => string;
  /** Fixed y range (e.g. [0, 1] for rates); defaults to the data extent. */
  yDomain?: [number, number];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverI, setHoverI] = useState<number | null>(null);

  const { xs, sx, sy, yTicks, xTickIdxs, byX } = useMemo(() => {
    const xSet = new Set<number>();
    for (const s of series) for (const p of s.points) xSet.add(p.x);
    const xs = [...xSet].sort((a, b) => a - b);

    let yMin = Infinity;
    let yMax = -Infinity;
    for (const s of series)
      for (const p of s.points) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    if (yDomain) {
      [yMin, yMax] = yDomain;
    } else {
      if (!Number.isFinite(yMin)) (yMin = 0), (yMax = 1);
      if (yMin === yMax) (yMin -= 1), (yMax += 1);
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad;
      yMax += pad;
    }

    const x0 = xs[0] ?? 0;
    const x1 = xs[xs.length - 1] ?? 1;
    const sx = scaleLinear([x0, x1], [M.l, W - M.r]);
    const sy = scaleLinear([yMin, yMax], [H - M.b, M.t]);
    const yTicks = (yDomain
      ? niceTicks(yMin, yMax, 4)
      : niceTicks(yMin, yMax, 4)
    ).filter((t) => t >= yMin && t <= yMax);

    // ≤ 5 x labels, snapped to real data positions
    const nLabels = Math.min(5, xs.length);
    const xTickIdxs = [
      ...new Set(
        Array.from({ length: nLabels }, (_, k) =>
          Math.round((k * (xs.length - 1)) / Math.max(1, nLabels - 1)),
        ),
      ),
    ];

    // per-series value lookup for the tooltip
    const byX = series.map((s) => new Map(s.points.map((p) => [p.x, p.y])));

    return { xs, sx, sy, yTicks, xTickIdxs, byX };
  }, [series, yDomain]);

  if (xs.length === 0) return null;

  function onMove(e: React.MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(sx(xs[i]) - px);
      if (d < bestD) (bestD = d), (best = i);
    }
    setHoverI(best);
  }

  const hoverX = hoverI !== null ? xs[hoverI] : null;
  const hoverPx = hoverX !== null ? sx(hoverX) : 0;

  return (
    <div className="relative">
      {series.length >= 2 && (
        <ChartLegend
          items={series.map((s) => ({
            name: s.name,
            color: s.color,
            kind: "line" as const,
          }))}
        />
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto block"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverI(null)}
      >
        {/* gridlines + y ticks */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={M.l}
              x2={W - M.r}
              y1={sy(t)}
              y2={sy(t)}
              stroke={t === 0 ? CHART.zero : CHART.grid}
              strokeWidth={1}
            />
            <text
              x={M.l - 6}
              y={sy(t) + 3}
              textAnchor="end"
              fontSize={10}
              fill={CHART.axisText}
            >
              {yFormatter(t)}
            </text>
          </g>
        ))}
        {/* x tick labels */}
        {xTickIdxs.map((i) => (
          <text
            key={i}
            x={sx(xs[i])}
            y={H - 6}
            textAnchor="middle"
            fontSize={10}
            fill={CHART.axisText}
          >
            {xFormatter(xs[i])}
          </text>
        ))}
        {/* area washes under lines */}
        {series.map(
          (s) =>
            s.area &&
            s.points.length >= 2 && (
              <path
                key={`a-${s.name}`}
                d={`${linePath(s.points.map((p) => ({ x: sx(p.x), y: sy(p.y) })))} L${sx(
                  s.points[s.points.length - 1].x,
                ).toFixed(1)} ${H - M.b} L${sx(s.points[0].x).toFixed(1)} ${H - M.b} Z`}
                fill={s.color}
                fillOpacity={0.1}
              />
            ),
        )}
        {/* lines */}
        {series.map((s) =>
          s.points.length >= 2 ? (
            <path
              key={s.name}
              d={linePath(s.points.map((p) => ({ x: sx(p.x), y: sy(p.y) })))}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : (
            // a single reading can't draw a line — show the point
            <circle
              key={s.name}
              cx={sx(s.points[0].x)}
              cy={sy(s.points[0].y)}
              r={4}
              fill={s.color}
              stroke={CHART.surface}
              strokeWidth={2}
            />
          ),
        )}
        {/* crosshair + markers */}
        {hoverX !== null && (
          <g>
            <line
              x1={hoverPx}
              x2={hoverPx}
              y1={M.t}
              y2={H - M.b}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={1}
            />
            {series.map((s, si) => {
              const y = byX[si].get(hoverX);
              return y === undefined ? null : (
                <circle
                  key={s.name}
                  cx={hoverPx}
                  cy={sy(y)}
                  r={4.5}
                  fill={s.color}
                  stroke={CHART.surface}
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}
      </svg>
      {hoverX !== null && (
        <TooltipBox
          heading={xFormatter(hoverX)}
          rows={series.flatMap((s, si) => {
            const y = byX[si].get(hoverX);
            return y === undefined
              ? []
              : [{ label: s.name, value: yFormatter(y), color: s.color }];
          })}
          style={{
            left: `${(hoverPx / W) * 100}%`,
            top: 8,
            transform:
              hoverPx > W * 0.55 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
          }}
        />
      )}
    </div>
  );
}
