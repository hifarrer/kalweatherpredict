"use client";

import { useMemo, useState } from "react";
import {
  barPath,
  CHART,
  formatDay,
  linePath,
  niceTicks,
  scaleLinear,
} from "@/components/charts/chartUtils";
import {
  ChartLegend,
  LegendItem,
  TooltipBox,
  TooltipRow,
} from "@/components/charts/ChartCard";

export interface BarSegment {
  name: string;
  color: string;
  values: number[]; // aligned to days; positives stack up, negatives down
}

const W = 600;
const H = 230;
const M = { t: 10, r: 10, b: 22, l: 48 };
const GAP = 2; // surface gap between stacked segments

/**
 * Daily bars (stacked, or sign-colored for P&L) with an optional same-unit
 * overlay line. Each day slot is its own hover target; the hovered day's
 * marks lift and one tooltip lists every value for that day.
 */
export function DailyBarsChart({
  days,
  segments,
  signColors = false,
  line,
  yFormatter,
  legend,
  tooltipExtra,
}: {
  days: string[];
  segments: BarSegment[];
  /** Single segment colored green/red by value sign (daily P&L). */
  signColors?: boolean;
  line?: { name: string; color: string; values: number[] };
  yFormatter: (v: number) => string;
  legend?: LegendItem[];
  tooltipExtra?: (dayIdx: number) => TooltipRow[];
}) {
  const [hoverI, setHoverI] = useState<number | null>(null);

  const { sy, yTicks, slot, barW, labelStep } = useMemo(() => {
    let yMin = 0;
    let yMax = 0;
    for (let i = 0; i < days.length; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of segments) {
        const v = s.values[i] ?? 0;
        if (v > 0) pos += v;
        else neg += v;
      }
      if (pos > yMax) yMax = pos;
      if (neg < yMin) yMin = neg;
      if (line) {
        const lv = line.values[i] ?? 0;
        if (lv > yMax) yMax = lv;
        if (lv < yMin) yMin = lv;
      }
    }
    if (yMin === 0 && yMax === 0) yMax = 1;
    const pad = (yMax - yMin) * 0.08;
    if (yMin < 0) yMin -= pad;
    yMax += pad;

    const sy = scaleLinear([yMin, yMax], [H - M.b, M.t]);
    const yTicks = niceTicks(yMin, yMax, 4).filter(
      (t) => t >= yMin && t <= yMax,
    );
    const slot = (W - M.l - M.r) / days.length;
    const barW = Math.min(24, slot * 0.65);
    const labelStep = Math.ceil(days.length / 7);
    return { sy, yTicks, slot, barW, labelStep };
  }, [days, segments, line]);

  const zeroY = sy(0);
  const cx = (i: number) => M.l + slot * i + slot / 2;

  return (
    <div className="relative">
      {legend && legend.length >= 2 && <ChartLegend items={legend} />}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto block"
        onMouseLeave={() => setHoverI(null)}
      >
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
        {days.map((day, i) =>
          i % labelStep === 0 ? (
            <text
              key={day}
              x={cx(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fill={CHART.axisText}
            >
              {formatDay(day)}
            </text>
          ) : null,
        )}
        {/* bars: positives stack up from 0, negatives down, 2px gaps */}
        {days.map((day, i) => {
          const lift = hoverI === i ? { filter: "brightness(1.25)" } : undefined;
          const ups = segments
            .map((s) => ({ s, v: s.values[i] ?? 0 }))
            .filter((e) => e.v > 0);
          const downs = segments
            .map((s) => ({ s, v: s.values[i] ?? 0 }))
            .filter((e) => e.v < 0);
          let yUp = zeroY;
          let yDown = zeroY;
          return (
            <g key={day} style={lift}>
              {ups.map((e, k) => {
                const h = zeroY - sy(e.v);
                const top = yUp - h;
                const el = (
                  <path
                    key={e.s.name}
                    d={barPath(cx(i), yUp, top, barW, k === ups.length - 1)}
                    fill={signColors ? CHART.pos : e.s.color}
                  />
                );
                yUp = top - GAP;
                return el;
              })}
              {downs.map((e, k) => {
                const h = sy(e.v) - zeroY;
                const bottom = yDown + h;
                const el = (
                  <path
                    key={e.s.name}
                    d={barPath(cx(i), yDown, bottom, barW, k === downs.length - 1)}
                    fill={signColors ? CHART.neg : e.s.color}
                  />
                );
                yDown = bottom + GAP;
                return el;
              })}
            </g>
          );
        })}
        {/* same-unit overlay line */}
        {line && days.length >= 2 && (
          <path
            d={linePath(days.map((_, i) => ({ x: cx(i), y: sy(line.values[i] ?? 0) })))}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {line && hoverI !== null && (
          <circle
            cx={cx(hoverI)}
            cy={sy(line.values[hoverI] ?? 0)}
            r={4.5}
            fill={line.color}
            stroke={CHART.surface}
            strokeWidth={2}
          />
        )}
        {/* per-day hit targets (bigger than the marks) */}
        {days.map((day, i) => (
          <rect
            key={day}
            x={M.l + slot * i}
            y={M.t}
            width={slot}
            height={H - M.t - M.b}
            fill="transparent"
            onMouseEnter={() => setHoverI(i)}
          />
        ))}
      </svg>
      {hoverI !== null && (
        <TooltipBox
          heading={formatDay(days[hoverI])}
          rows={[
            ...segments.map((s) => {
              const v = s.values[hoverI] ?? 0;
              return {
                label: s.name,
                value: yFormatter(v),
                color: signColors ? (v < 0 ? CHART.neg : CHART.pos) : s.color,
              };
            }),
            ...(line
              ? [
                  {
                    label: line.name,
                    value: yFormatter(line.values[hoverI] ?? 0),
                    color: line.color,
                  },
                ]
              : []),
            ...(tooltipExtra ? tooltipExtra(hoverI) : []),
          ]}
          style={{
            left: `${((M.l + slot * hoverI + slot / 2) / W) * 100}%`,
            top: 8,
            transform:
              M.l + slot * hoverI + slot / 2 > W * 0.55
                ? "translateX(calc(-100% - 10px))"
                : "translateX(10px)",
          }}
        />
      )}
    </div>
  );
}
