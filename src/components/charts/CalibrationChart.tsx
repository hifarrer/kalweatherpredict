"use client";

import { useState } from "react";
import { CHART, linePath, scaleLinear } from "@/components/charts/chartUtils";
import { TooltipBox } from "@/components/charts/ChartCard";

export interface ReliabilityPt {
  midpoint: number; // predicted-probability bucket center, 0..1
  observed: number; // observed YES frequency, 0..1
  n: number;
}

const S = 260;
const M = { t: 10, r: 12, b: 30, l: 36 };

/**
 * Calibration (reliability) curve: predicted probability vs observed YES
 * frequency per bucket. Perfect calibration lies on the dashed diagonal;
 * point size scales with sample count.
 */
export function CalibrationChart({ points }: { points: ReliabilityPt[] }) {
  const [hoverI, setHoverI] = useState<number | null>(null);

  const sx = scaleLinear([0, 1], [M.l, S - M.r]);
  const sy = scaleLinear([0, 1], [S - M.b, M.t]);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const r = (n: number) => Math.min(10, 3.5 + Math.sqrt(n));

  return (
    <div className="relative mx-auto max-w-[320px]">
      <svg viewBox={`0 0 ${S} ${S}`} className="w-full h-auto block">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={M.l}
              x2={S - M.r}
              y1={sy(t)}
              y2={sy(t)}
              stroke={CHART.grid}
              strokeWidth={1}
            />
            <text
              x={M.l - 5}
              y={sy(t) + 3}
              textAnchor="end"
              fontSize={9}
              fill={CHART.axisText}
            >
              {Math.round(t * 100)}%
            </text>
            <text
              x={sx(t)}
              y={S - M.b + 12}
              textAnchor="middle"
              fontSize={9}
              fill={CHART.axisText}
            >
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {/* y = x reference: on the line = perfectly calibrated */}
        <line
          x1={sx(0)}
          y1={sy(0)}
          x2={sx(1)}
          y2={sy(1)}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        {points.length >= 2 && (
          <path
            d={linePath(points.map((p) => ({ x: sx(p.midpoint), y: sy(p.observed) })))}
            fill="none"
            stroke={CHART.cat1}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {points.map((p, i) => (
          <g key={p.midpoint}>
            <circle
              cx={sx(p.midpoint)}
              cy={sy(p.observed)}
              r={r(p.n)}
              fill={CHART.cat1}
              stroke={CHART.surface}
              strokeWidth={2}
              style={hoverI === i ? { filter: "brightness(1.25)" } : undefined}
            />
            {/* oversized hit target */}
            <circle
              cx={sx(p.midpoint)}
              cy={sy(p.observed)}
              r={14}
              fill="transparent"
              onMouseEnter={() => setHoverI(i)}
              onMouseLeave={() => setHoverI(null)}
            />
          </g>
        ))}
        <text
          x={(M.l + S - M.r) / 2}
          y={S - 4}
          textAnchor="middle"
          fontSize={9}
          fill={CHART.axisText}
        >
          Predicted probability
        </text>
      </svg>
      {hoverI !== null && (
        <TooltipBox
          heading={`Predicted ~${Math.round(points[hoverI].midpoint * 100)}%`}
          rows={[
            {
              label: "Observed YES",
              value: `${Math.round(points[hoverI].observed * 100)}%`,
              color: CHART.cat1,
            },
            { label: "Markets", value: String(points[hoverI].n) },
          ]}
          style={{
            left: `${(sx(points[hoverI].midpoint) / S) * 100}%`,
            top: `${(sy(points[hoverI].observed) / S) * 100}%`,
            transform:
              points[hoverI].midpoint > 0.55
                ? "translate(calc(-100% - 12px), -50%)"
                : "translate(12px, -50%)",
          }}
        />
      )}
    </div>
  );
}
