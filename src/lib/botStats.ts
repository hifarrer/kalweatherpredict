import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { DailyAccuracyPoint, ReliabilityPoint } from "@/lib/statsAgg";

/**
 * Bot performance chart data for the stats pages: balance over time (from
 * automation runs), realized P&L per day (from closed positions), and
 * exit-reason breakdown. Shared by the weather and crypto stats routes —
 * everything is parameterized by section.
 *
 * All money values are integer cents; days are "YYYY-MM-DD" strings bucketed
 * on the US/Eastern calendar (Kalshi's exchange day).
 */

export type BotSection = "weather" | "crypto";

/** Kalshi's exchange day — all daily buckets use this zone. */
export const BUCKET_TZ = "America/New_York";

export interface BalancePoint {
  t: string; // ISO timestamp of the run
  balanceCents: number; // account-wide cash balance at run time
  deployedCents: number; // capital in this section's open positions
}

export interface DailyPnlRow {
  day: string; // "YYYY-MM-DD" (ET)
  pnlCents: number;
  wins: number; // closed positions with pnl > 0
  losses: number; // closed positions with pnl < 0
  closed: number; // all positions closed that day
}

export interface DailyPnlPoint extends DailyPnlRow {
  cumPnlCents: number;
  cumWins: number;
  cumLosses: number;
}

export interface ExitReasonStat {
  reason: string; // take_profit | stop_loss | settled | manual
  count: number;
  pnlCents: number; // net realized P&L for this exit reason
}

export interface BotPerfCharts {
  balanceSeries: BalancePoint[];
  daily: DailyPnlPoint[];
  exitReasons: ExitReasonStat[];
}

/** Full `charts` payload the stats routes attach and the pages consume. */
export interface BotChartsPayload extends BotPerfCharts {
  accuracyDaily: DailyAccuracyPoint[];
  reliability: ReliabilityPoint[];
}

/**
 * Zero-fill missing days between the first and last row (so cumulative lines
 * are continuous and bar spacing is truthful) and accumulate running totals.
 * Input must be ascending by day.
 */
export function fillDailyGaps(rows: DailyPnlRow[]): DailyPnlPoint[] {
  if (rows.length === 0) return [];
  const out: DailyPnlPoint[] = [];
  let cumPnlCents = 0;
  let cumWins = 0;
  let cumLosses = 0;
  const DAY_MS = 86_400_000;
  const last = Date.parse(`${rows[rows.length - 1].day}T00:00:00Z`);
  let i = 0;
  for (let t = Date.parse(`${rows[0].day}T00:00:00Z`); t <= last; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const row =
      i < rows.length && rows[i].day === day
        ? rows[i++]
        : { day, pnlCents: 0, wins: 0, losses: 0, closed: 0 };
    cumPnlCents += row.pnlCents;
    cumWins += row.wins;
    cumLosses += row.losses;
    out.push({ ...row, cumPnlCents, cumWins, cumLosses });
  }
  return out;
}

export async function getBotPerfCharts(
  section: BotSection,
): Promise<BotPerfCharts> {
  // Balance series: the last run of each hour, capped at 90 days. balance_cents
  // is null on runs that failed before fetching the balance.
  const balanceResult = await db.execute(sql`
    SELECT DISTINCT ON (date_trunc('hour', started_at))
           started_at, balance_cents, coalesce(deployed_cents, 0) AS deployed_cents
    FROM automation_runs
    WHERE section = ${section}
      AND balance_cents IS NOT NULL
      AND started_at > now() - interval '90 days'
    ORDER BY date_trunc('hour', started_at), started_at DESC
  `);

  // Daily realized P&L over fully closed positions. Partially sold positions
  // carry realized_pnl_cents while still open — that slice is attributed to
  // the day the position finishes closing (closed_at), so totals here can
  // trail the automation page's sum until in-flight positions close.
  const dailyResult = await db.execute(sql`
    SELECT to_char((closed_at AT TIME ZONE ${BUCKET_TZ})::date, 'YYYY-MM-DD') AS day,
           sum(realized_pnl_cents)::int AS pnl_cents,
           (count(*) FILTER (WHERE realized_pnl_cents > 0))::int AS wins,
           (count(*) FILTER (WHERE realized_pnl_cents < 0))::int AS losses,
           count(*)::int AS closed
    FROM automation_positions
    WHERE section = ${section}
      AND status = 'closed'
      AND realized_pnl_cents IS NOT NULL
      AND closed_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);

  const exitResult = await db.execute(sql`
    SELECT coalesce(exit_reason, 'other') AS reason,
           count(*)::int AS count,
           sum(realized_pnl_cents)::int AS pnl_cents
    FROM automation_positions
    WHERE section = ${section}
      AND status = 'closed'
      AND realized_pnl_cents IS NOT NULL
    GROUP BY 1
    ORDER BY count DESC
  `);

  const balanceSeries = (
    balanceResult.rows as unknown as {
      started_at: Date;
      balance_cents: number;
      deployed_cents: number;
    }[]
  ).map((r) => ({
    t: new Date(r.started_at).toISOString(),
    balanceCents: Number(r.balance_cents),
    deployedCents: Number(r.deployed_cents),
  }));

  const daily = fillDailyGaps(
    (
      dailyResult.rows as unknown as {
        day: string;
        pnl_cents: number;
        wins: number;
        losses: number;
        closed: number;
      }[]
    ).map((r) => ({
      day: r.day,
      pnlCents: Number(r.pnl_cents),
      wins: Number(r.wins),
      losses: Number(r.losses),
      closed: Number(r.closed),
    })),
  );

  const exitReasons = (
    exitResult.rows as unknown as {
      reason: string;
      count: number;
      pnl_cents: number;
    }[]
  ).map((r) => ({
    reason: r.reason,
    count: Number(r.count),
    pnlCents: Number(r.pnl_cents),
  }));

  return { balanceSeries, daily, exitReasons };
}
