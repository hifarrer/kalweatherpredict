"use client";

import type { BotChartsPayload } from "@/lib/botStats";
import { ChartCard } from "@/components/charts/ChartCard";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { DailyBarsChart } from "@/components/charts/DailyBarsChart";
import { CalibrationChart } from "@/components/charts/CalibrationChart";
import { BreakdownBars } from "@/components/charts/BreakdownBars";
import {
  CHART,
  formatCents,
  formatDay,
  formatPct,
  formatRunTime,
} from "@/components/charts/chartUtils";

const REASON_LABELS: Record<string, string> = {
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  settled: "Held to settle",
  manual: "Manual",
  other: "Other",
};

/**
 * The money charts: account value, realized P&L, trade outcomes, win rate,
 * and exit reasons — how the auto-trader itself is performing.
 */
export function BotPerformanceSection({ charts }: { charts: BotChartsPayload }) {
  const { balanceSeries, daily, exitReasons } = charts;

  const heading = (
    <h2 className="text-sm font-bold text-kalshi-text mb-2">Bot performance</h2>
  );

  if (balanceSeries.length === 0 && daily.length === 0) {
    return (
      <div>
        {heading}
        <p className="text-xs text-kalshi-muted">
          No bot activity recorded yet — charts appear once the automation has
          run and closed positions.
        </p>
      </div>
    );
  }

  const balancePoints = balanceSeries.map((b) => ({
    x: Date.parse(b.t),
    total: b.balanceCents + b.deployedCents,
    cash: b.balanceCents,
  }));

  const days = daily.map((d) => d.day);
  // cumulative win rate exists only from the first decided (non-zero P&L) trade
  const winRatePoints = daily
    .map((d, i) => ({ x: i, decided: d.cumWins + d.cumLosses, wins: d.cumWins }))
    .filter((p) => p.decided > 0)
    .map((p) => ({ x: p.x, y: p.wins / p.decided }));

  return (
    <div>
      {heading}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Account value"
          subtitle="Kalshi cash balance + capital in this bot's open positions, sampled each run"
          empty={
            balancePoints.length < 2
              ? "Needs at least two automation runs with a balance reading."
              : null
          }
        >
          <TimeSeriesChart
            series={[
              {
                name: "Account value",
                color: CHART.cat1,
                area: true,
                points: balancePoints.map((b) => ({ x: b.x, y: b.total })),
              },
              {
                name: "Cash balance",
                color: CHART.cat2,
                points: balancePoints.map((b) => ({ x: b.x, y: b.cash })),
              },
            ]}
            xFormatter={formatRunTime}
            yFormatter={formatCents}
          />
        </ChartCard>

        <ChartCard
          title="Realized P&L"
          subtitle="Net of all fees, by the day the position closed (ET)"
          empty={daily.length === 0 ? "No closed positions yet." : null}
        >
          <DailyBarsChart
            days={days}
            segments={[
              {
                name: "Daily P&L",
                color: CHART.pos,
                values: daily.map((d) => d.pnlCents),
              },
            ]}
            signColors
            line={{
              name: "Cumulative",
              color: CHART.cat1,
              values: daily.map((d) => d.cumPnlCents),
            }}
            yFormatter={formatCents}
            legend={[
              { name: "Daily P&L", kind: "dual", color: CHART.pos, color2: CHART.neg },
              { name: "Cumulative", kind: "line", color: CHART.cat1 },
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Trade outcomes"
          subtitle="Closed positions per day — wins (P&L > 0) vs losses"
          empty={daily.length === 0 ? "No closed positions yet." : null}
        >
          <DailyBarsChart
            days={days}
            segments={[
              { name: "Wins", color: CHART.pos, values: daily.map((d) => d.wins) },
              { name: "Losses", color: CHART.neg, values: daily.map((d) => d.losses) },
            ]}
            yFormatter={(v) => (Number.isInteger(v) ? String(v) : "")}
            legend={[
              { name: "Wins", kind: "rect", color: CHART.pos },
              { name: "Losses", kind: "rect", color: CHART.neg },
            ]}
            tooltipExtra={(i) => {
              const d = daily[i];
              const dayDecided = d.wins + d.losses;
              const cumDecided = d.cumWins + d.cumLosses;
              return [
                ...(dayDecided > 0
                  ? [
                      {
                        label: "Day win rate",
                        value: formatPct(d.wins / dayDecided),
                      },
                    ]
                  : []),
                ...(cumDecided > 0
                  ? [
                      {
                        label: "Cumulative",
                        value: formatPct(d.cumWins / cumDecided),
                      },
                    ]
                  : []),
              ];
            }}
          />
        </ChartCard>

        <ChartCard
          title="Win rate"
          subtitle="Cumulative share of closed positions that made money"
          empty={
            winRatePoints.length < 2
              ? "Needs closed trades on at least two days."
              : null
          }
        >
          <TimeSeriesChart
            series={[
              { name: "Win rate", color: CHART.cat1, points: winRatePoints },
            ]}
            xFormatter={(i) => formatDay(days[Math.round(i)] ?? "")}
            yFormatter={formatPct}
            yDomain={[0, 1]}
          />
        </ChartCard>

        <div className="lg:col-span-2">
          <ChartCard
            title="Exits"
            subtitle="How closed positions ended, with net P&L per exit path"
            empty={exitReasons.length === 0 ? "No closed positions yet." : null}
          >
            <BreakdownBars
              rows={exitReasons.map((r) => ({
                label: REASON_LABELS[r.reason] ?? r.reason,
                count: r.count,
                pnlCents: r.pnlCents,
              }))}
            />
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

/**
 * The model charts: daily Brier trend vs the market, and the calibration
 * curve — how good the probabilities are, independent of trading.
 */
export function ModelAccuracyCharts({ charts }: { charts: BotChartsPayload }) {
  const { accuracyDaily, reliability } = charts;
  if (accuracyDaily.length < 2 && reliability.length < 2) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard
        title="Model vs market"
        subtitle="Brier score by market target day — lower is better"
        empty={
          accuracyDaily.length < 2
            ? "Needs graded markets on at least two days."
            : null
        }
      >
        <TimeSeriesChart
          series={[
            {
              name: "Model Brier",
              color: CHART.cat1,
              points: accuracyDaily.map((d, i) => ({ x: i, y: d.brier })),
            },
            {
              name: "Market Brier",
              color: CHART.cat2,
              points: accuracyDaily.flatMap((d, i) =>
                d.marketBrier === null ? [] : [{ x: i, y: d.marketBrier }],
              ),
            },
          ]}
          xFormatter={(i) =>
            formatDay(accuracyDaily[Math.round(i)]?.day ?? "")
          }
          yFormatter={(v) => v.toFixed(2)}
        />
      </ChartCard>

      <ChartCard
        title="Calibration"
        subtitle="Predicted probability vs observed outcome — perfect calibration sits on the diagonal; point size = sample count"
        empty={
          reliability.length < 2
            ? "Needs graded markets across at least two probability buckets."
            : null
        }
      >
        <CalibrationChart points={reliability} />
      </ChartCard>
    </div>
  );
}
