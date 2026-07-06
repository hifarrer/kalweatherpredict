import { NextResponse } from "next/server";
import { desc, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  automationActions,
  automationPositions,
  automationRuns,
  events,
} from "@/db/schema";
import { getBalance, isTradingConfigured } from "@/lib/kalshiTrade";
import { getAutomationSettings } from "@/lib/autoSettings";
import { KalshiEvent } from "@/types";

export const dynamic = "force-dynamic";

const RECENT_RUNS = 20;

/** Everything the /automation page needs in one round trip. */
export async function GET() {
  const settings = await getAutomationSettings();

  let balanceCents: number | null = null;
  if (isTradingConfigured()) {
    try {
      balanceCents = (await getBalance()).balance;
    } catch {
      // balance is display-only here; the page shows "unavailable"
    }
  }

  const openPositions = await db
    .select()
    .from(automationPositions)
    .where(inArray(automationPositions.status, ["open", "closing"]))
    .orderBy(desc(automationPositions.openedAt));

  // Current bids from the cached events table (fresh enough for display)
  const eventTickers = [...new Set(openPositions.map((p) => p.eventTicker))];
  const eventRows = eventTickers.length
    ? await db
        .select({ eventTicker: events.eventTicker, data: events.data })
        .from(events)
        .where(inArray(events.eventTicker, eventTickers))
    : [];
  const eventByTicker = new Map(
    eventRows.map((r) => [r.eventTicker, r.data as unknown as KalshiEvent]),
  );

  const positions = openPositions.map((p) => {
    const market = eventByTicker
      .get(p.eventTicker)
      ?.markets?.find((m) => m.ticker === p.ticker);
    const bidRaw =
      p.side === "yes" ? market?.yes_bid_dollars : market?.no_bid_dollars;
    const bidCents = bidRaw ? Math.round(parseFloat(bidRaw) * 100) : null;
    const unrealizedPnlCents =
      bidCents !== null
        ? p.count * (bidCents - p.avgCostCents - (p.buyFeeCents ?? 0))
        : null;
    return { ...p, bidCents, unrealizedPnlCents, marketTitle: market?.yes_sub_title ?? null };
  });

  const deployedCents = openPositions.reduce(
    (sum, p) => sum + p.count * (p.avgCostCents + (p.buyFeeCents ?? 0)),
    0,
  );

  const [{ total: realizedPnlCents }] = await db
    .select({
      total: sql<number>`coalesce(sum(${automationPositions.realizedPnlCents}), 0)::int`,
    })
    .from(automationPositions)
    .where(isNotNull(automationPositions.realizedPnlCents));

  const runs = await db
    .select()
    .from(automationRuns)
    .orderBy(desc(automationRuns.startedAt))
    .limit(RECENT_RUNS);

  const runIds = runs.map((r) => r.id);
  const actions = runIds.length
    ? await db
        .select()
        .from(automationActions)
        .where(inArray(automationActions.runId, runIds))
        .orderBy(desc(automationActions.createdAt))
    : [];
  const actionsByRun = new Map<number, typeof actions>();
  for (const a of actions) {
    const list = actionsByRun.get(a.runId) ?? [];
    list.push(a);
    actionsByRun.set(a.runId, list);
  }

  return NextResponse.json({
    settings,
    tradingConfigured: isTradingConfigured(),
    cronConfigured: !!process.env.CRON_SECRET,
    balanceCents,
    deployedCents,
    realizedPnlCents,
    positions,
    runs: runs.map((r) => ({ ...r, actions: actionsByRun.get(r.id) ?? [] })),
  });
}
