"use client";

import { PredictionResult, WeatherForecast } from "@/types";
import { MODEL_LABELS } from "@/lib/weather";

interface ForecastPanelProps {
  forecast: WeatherForecast;
  prediction: PredictionResult | null;
}

/**
 * Expandable per-event forecast detail: hourly temperature sparkline
 * (past 24h + next 72h), per-model point forecasts for the target day,
 * and a mini daily-max trend — so you can see WHY a bracket was picked.
 */
export default function ForecastPanel({ forecast, prediction }: ForecastPanelProps) {
  const targetDate = prediction?.targetDate;
  const targetDay =
    (targetDate ? forecast.daily.find((d) => d.date === targetDate) : undefined) ??
    forecast.daily[0];

  const isTemp =
    !prediction ||
    prediction.metric === "temperature_high" ||
    prediction.metric === "temperature_low";

  return (
    <div className="space-y-3 px-1 py-2">
      <HourlySparkline forecast={forecast} prediction={prediction} />

      {targetDay?.byModel && (
        <div>
          <p className="text-[10px] text-kalshi-muted uppercase tracking-wide mb-1">
            Models for {targetDay.date}
            {forecast.stationId && (
              <span className="ml-1 normal-case">· station {forecast.stationId}</span>
            )}
          </p>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-kalshi-muted text-left">
                <th className="font-medium pb-0.5">Model</th>
                <th className="font-medium pb-0.5 text-right">High</th>
                <th className="font-medium pb-0.5 text-right">Low</th>
                <th className="font-medium pb-0.5 text-right">Precip</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(targetDay.byModel).map(([model, v]) => (
                <tr key={model} className="text-kalshi-text">
                  <td className="py-0.5">{MODEL_LABELS[model] ?? model}</td>
                  <td className="py-0.5 text-right">{v.max !== null ? `${Math.round(v.max)}°` : "—"}</td>
                  <td className="py-0.5 text-right">{v.min !== null ? `${Math.round(v.min)}°` : "—"}</td>
                  <td className="py-0.5 text-right">{v.precip !== null ? `${v.precip.toFixed(2)}"` : "—"}</td>
                </tr>
              ))}
              <tr className="text-kalshi-green font-semibold border-t border-kalshi-border">
                <td className="py-0.5">Median</td>
                <td className="py-0.5 text-right">{targetDay.max}°</td>
                <td className="py-0.5 text-right">{targetDay.min}°</td>
                <td className="py-0.5 text-right">{(targetDay.precip ?? 0).toFixed(2)}&quot;</td>
              </tr>
              {targetDay.spread && (
                <tr className="text-kalshi-muted">
                  <td className="py-0.5">Spread (σ)</td>
                  <td className="py-0.5 text-right">±{targetDay.spread.max.toFixed(1)}</td>
                  <td className="py-0.5 text-right">±{targetDay.spread.min.toFixed(1)}</td>
                  <td className="py-0.5 text-right">±{targetDay.spread.precip.toFixed(2)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {isTemp && <DailyTrend forecast={forecast} targetDate={targetDay?.date} />}
    </div>
  );
}

function HourlySparkline({
  forecast,
  prediction,
}: {
  forecast: WeatherForecast;
  prediction: PredictionResult | null;
}) {
  const times = forecast.hourlyTimes;
  const temps = forecast.hourlyTemps;
  if (!times || times.length < 2) return null;

  const W = 280;
  const H = 60;
  const PAD = 4;

  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const range = Math.max(1, max - min);
  const x = (i: number) => PAD + (i / (times.length - 1)) * (W - 2 * PAD);
  const y = (t: number) => H - PAD - ((t - min) / range) * (H - 2 * PAD);

  // Boundary between elapsed and future hours
  const pastCount = forecast.pastHours?.times.length ?? 0;
  const nowIdx = Math.max(0, Math.min(times.length - 1, pastCount - 1));

  const pastPoints = temps
    .slice(0, nowIdx + 1)
    .map((t, i) => `${x(i).toFixed(1)},${y(t).toFixed(1)}`)
    .join(" ");
  const futurePoints = temps
    .slice(nowIdx)
    .map((t, i) => `${x(nowIdx + i).toFixed(1)},${y(t).toFixed(1)}`)
    .join(" ");

  // Strike line for the matched market (temperature metrics only)
  const m = prediction?.matchedMarket;
  const strikeValue =
    prediction &&
    (prediction.metric === "temperature_high" || prediction.metric === "temperature_low") &&
    m
      ? m.strike_type === "between"
        ? m.floor_strike
        : m.floor_strike ?? m.cap_strike
      : null;
  const showStrike = strikeValue !== null && strikeValue >= min && strikeValue <= max;

  return (
    <div>
      <p className="text-[10px] text-kalshi-muted uppercase tracking-wide mb-1">
        Hourly temp — past 24h + next 72h
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {/* past segment (muted) */}
        {pastPoints && (
          <polyline
            points={pastPoints}
            fill="none"
            stroke="rgba(139, 139, 154, 0.7)"
            strokeWidth="1.5"
          />
        )}
        {/* future segment */}
        {futurePoints && (
          <polyline
            points={futurePoints}
            fill="none"
            stroke="#f7931a"
            strokeWidth="1.5"
          />
        )}
        {/* now marker */}
        <line
          x1={x(nowIdx)}
          y1={PAD}
          x2={x(nowIdx)}
          y2={H - PAD}
          stroke="rgba(255,255,255,0.35)"
          strokeWidth="1"
          strokeDasharray="2,2"
        />
        {/* strike line */}
        {showStrike && (
          <>
            <line
              x1={PAD}
              y1={y(strikeValue as number)}
              x2={W - PAD}
              y2={y(strikeValue as number)}
              stroke="#2ecc71"
              strokeWidth="1"
              strokeDasharray="4,3"
            />
            <text
              x={W - PAD}
              y={y(strikeValue as number) - 2}
              textAnchor="end"
              fontSize="8"
              fill="#2ecc71"
            >
              {strikeValue}°
            </text>
          </>
        )}
        {/* min/max labels */}
        <text x={PAD} y={y(max) + 8} fontSize="8" fill="#8b8b9a">
          {max}°
        </text>
        <text x={PAD} y={y(min) - 2} fontSize="8" fill="#8b8b9a">
          {min}°
        </text>
      </svg>
    </div>
  );
}

function DailyTrend({
  forecast,
  targetDate,
}: {
  forecast: WeatherForecast;
  targetDate?: string;
}) {
  const days = forecast.daily.slice(0, 6);
  if (days.length === 0) return null;

  const maxTemp = Math.max(...days.map((d) => d.max));
  const minTemp = Math.min(...days.map((d) => d.max));
  const range = Math.max(1, maxTemp - minTemp);

  return (
    <div>
      <p className="text-[10px] text-kalshi-muted uppercase tracking-wide mb-1">
        Daily highs — next {days.length} days
      </p>
      <div className="flex items-end gap-1.5 h-14">
        {days.map((d) => {
          const hFrac = 0.3 + (0.7 * (d.max - minTemp)) / range;
          const isTarget = d.date === targetDate;
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5">
              <span className={`text-[9px] ${isTarget ? "text-kalshi-green font-bold" : "text-kalshi-muted"}`}>
                {d.max}°
              </span>
              <div
                className={`w-full rounded-sm ${isTarget ? "bg-kalshi-green/70" : "bg-kalshi-orange/40"}`}
                style={{ height: `${Math.round(hFrac * 36)}px` }}
              />
              <span className="text-[8px] text-kalshi-muted">{d.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
