import { NextResponse } from "next/server";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events } from "@/db/schema";
import { KalshiEvent } from "@/types";

export const dynamic = "force-dynamic";

interface HistoryQueryRow {
  id: number;
  ticker: string;
  event_ticker: string;
  side: string;
  count: number;
  fill_count: number | null;
  avg_fill_price_cents: number | null;
  avg_fee_cents: number | null;
  status: string;
  suggestion_id: number | null;
  created_at: string;
  event_title: string | null;
  city_code: string | null;
  result: string | null;
  actual_value: number | null;
  settled_at: string | null;
  sugg_win_prob: number | null;
  sugg_ev: number | null;
  sugg_kind: string | null;
}

export type HistoryOutcome = "won" | "lost" | "pending" | "none";

/**
 * Order history with settlement outcomes and P&L.
 *
 * Outcome is derived by joining each order's market ticker to the settlements
 * table: the order won if the bought side matches the settlement result.
 * "none" marks failed/canceled/zero-fill orders, which are excluded from the
 * summary totals. P&L is net of Kalshi fees (charged at fill, so losses
 * include them) and always based on fill_count — IOC orders can partially fill.
 */
export async function GET() {
  try {
    const result = await db.execute(sql`
      SELECT o.id, o.ticker, o.event_ticker, o.side, o.count, o.fill_count,
             o.avg_fill_price_cents, o.avg_fee_cents, o.status, o.suggestion_id,
             o.created_at,
             e.title AS event_title, e.city_code,
             s.result, s.actual_value, s.settled_at,
             sg.win_prob AS sugg_win_prob, sg.ev_per_contract AS sugg_ev,
             sg.kind AS sugg_kind
      FROM orders o
      LEFT JOIN events e ON e.event_ticker = o.event_ticker
      LEFT JOIN settlements s ON s.market_ticker = o.ticker
      LEFT JOIN suggestions sg ON sg.id = o.suggestion_id
      ORDER BY o.created_at DESC
      LIMIT 500
    `);
    const rows = result.rows as unknown as HistoryQueryRow[];

    // Human market titles (bracket labels like "76° to 77°") live in the
    // cached event jsonb — one fetch per distinct event, not per order.
    const eventTickers = [...new Set(rows.map((r) => r.event_ticker))];
    const marketTitleByTicker = new Map<string, string>();
    if (eventTickers.length > 0) {
      const eventRows = await db
        .select({ data: events.data })
        .from(events)
        .where(inArray(events.eventTicker, eventTickers));
      for (const er of eventRows) {
        const ev = er.data as unknown as KalshiEvent;
        for (const m of ev.markets ?? []) {
          if (m.yes_sub_title) marketTitleByTicker.set(m.ticker, m.yes_sub_title);
        }
      }
    }

    let totalStakedCents = 0;
    let totalFeesCents = 0;
    let realizedPnlCents = 0;
    let wins = 0;
    let losses = 0;
    let pending = 0;
    let filledOrders = 0;

    const orderRows = rows.map((r) => {
      const filled = r.fill_count ?? 0;
      const costCents =
        r.avg_fill_price_cents !== null ? filled * Number(r.avg_fill_price_cents) : 0;
      const feesCents = filled * Number(r.avg_fee_cents ?? 0);

      const dead =
        filled === 0 || r.status === "failed" || (r.status === "canceled" && filled === 0);
      let outcome: HistoryOutcome;
      let pnlCents: number | null = null;
      if (dead) {
        outcome = "none";
      } else if (r.result === null) {
        outcome = "pending";
        pending++;
      } else if (r.result === r.side) {
        outcome = "won";
        pnlCents = filled * 100 - costCents - feesCents;
        wins++;
      } else {
        outcome = "lost";
        pnlCents = -costCents - feesCents;
        losses++;
      }

      if (!dead) {
        filledOrders++;
        totalStakedCents += costCents;
        totalFeesCents += feesCents;
        if (pnlCents !== null) realizedPnlCents += pnlCents;
      }

      return {
        id: r.id,
        ticker: r.ticker,
        eventTicker: r.event_ticker,
        eventTitle: r.event_title,
        marketTitle: marketTitleByTicker.get(r.ticker) ?? null,
        cityCode: r.city_code,
        side: r.side,
        count: r.count,
        fillCount: filled,
        avgFillPriceCents:
          r.avg_fill_price_cents !== null ? Number(r.avg_fill_price_cents) : null,
        costCents,
        feesCents,
        status: r.status,
        outcome,
        actualValue: r.actual_value !== null ? Number(r.actual_value) : null,
        pnlCents,
        fromSuggestion: r.suggestion_id !== null,
        suggestionWinProb: r.sugg_win_prob !== null ? Number(r.sugg_win_prob) : null,
        suggestionEv: r.sugg_ev !== null ? Number(r.sugg_ev) : null,
        suggestionKind: r.sugg_kind,
        createdAt: r.created_at,
        settledAt: r.settled_at,
      };
    });

    return NextResponse.json({
      orders: orderRows,
      summary: {
        totalOrders: rows.length,
        filledOrders,
        totalStakedCents,
        totalFeesCents,
        realizedPnlCents,
        wins,
        losses,
        pending,
        winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("History API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
