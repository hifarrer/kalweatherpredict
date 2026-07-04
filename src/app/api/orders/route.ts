import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { events, orders } from "@/db/schema";
import {
  createOrder,
  isTradingConfigured,
  KalshiTradeError,
} from "@/lib/kalshiTrade";
import { KalshiEvent } from "@/types";

export const dynamic = "force-dynamic";

const MAX_COST_BUFFER_CENTS = 5; // per contract, on top of the quoted ask

function maxOrderContracts(): number {
  const v = parseInt(process.env.MAX_ORDER_CONTRACTS || "100", 10);
  return Number.isFinite(v) && v > 0 ? v : 100;
}

/**
 * Place a market buy order on Kalshi.
 * Body: { ticker, eventTicker, side: "yes"|"no", count, askCents }
 * askCents = the ask price shown to the user; the order's buy_max_cost is
 * count × (askCents + buffer) so a moved book can't overspend.
 */
export async function POST(req: NextRequest) {
  if (!isTradingConfigured()) {
    return NextResponse.json(
      { error: "Kalshi trading is not configured. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_BASE64." },
      { status: 503 },
    );
  }

  let body: {
    ticker?: string;
    eventTicker?: string;
    side?: string;
    count?: number;
    askCents?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { ticker, eventTicker, side, count, askCents } = body;

  if (!ticker || !eventTicker) {
    return NextResponse.json({ error: "ticker and eventTicker are required" }, { status: 400 });
  }
  if (side !== "yes" && side !== "no") {
    return NextResponse.json({ error: "side must be 'yes' or 'no'" }, { status: 400 });
  }
  const max = maxOrderContracts();
  if (!Number.isInteger(count) || count! < 1 || count! > max) {
    return NextResponse.json(
      { error: `count must be an integer between 1 and ${max}` },
      { status: 400 },
    );
  }
  if (!Number.isInteger(askCents) || askCents! < 1 || askCents! > 99) {
    return NextResponse.json({ error: "askCents must be 1-99" }, { status: 400 });
  }

  // Validate the market exists in our cached open events (defense against
  // arbitrary-ticker orders from a compromised/buggy client).
  const rows = await db
    .select({ data: events.data })
    .from(events)
    .where(eq(events.eventTicker, eventTicker));
  const event = rows[0]?.data as unknown as KalshiEvent | undefined;
  const market = event?.markets?.find((m) => m.ticker === ticker);
  if (!market) {
    return NextResponse.json(
      { error: "Unknown market — refresh the event and try again" },
      { status: 400 },
    );
  }

  const clientOrderId = randomUUID();
  const maxPriceCents = askCents! + MAX_COST_BUFFER_CENTS;

  // Audit row first (idempotency anchor), then the Kalshi call.
  const [orderRow] = await db
    .insert(orders)
    .values({
      clientOrderId,
      ticker,
      eventTicker,
      side,
      action: "buy",
      type: "market", // emulated: immediate-or-cancel at ask + buffer
      count: count!,
      maxCostCents: count! * maxPriceCents,
      status: "pending",
    })
    .returning({ id: orders.id });

  try {
    const placed = await createOrder({
      ticker,
      clientOrderId,
      side,
      count: count!,
      maxPriceCents,
    });

    const fillCost =
      placed.avgFillPriceCents !== null ? placed.fillCount * placed.avgFillPriceCents : null;

    await db
      .update(orders)
      .set({
        status: placed.status,
        kalshiOrderId: placed.orderId,
        avgFillPriceCents: placed.avgFillPriceCents,
        response: placed.raw as Record<string, unknown>,
      })
      .where(eq(orders.id, orderRow.id));

    return NextResponse.json({
      ok: true,
      orderId: placed.orderId,
      status: placed.status,
      fillCount: placed.fillCount,
      fillCostCents: fillCost,
      avgFillPriceCents: placed.avgFillPriceCents,
      avgFeeCents: placed.avgFeeCents,
    });
  } catch (err) {
    const message =
      err instanceof KalshiTradeError ? err.message : "Order failed";
    await db
      .update(orders)
      .set({
        status: "failed",
        response: {
          error: message,
          detail: err instanceof KalshiTradeError ? err.body : String(err),
        },
      })
      .where(eq(orders.id, orderRow.id));
    console.error("Order placement failed:", err);
    const status = err instanceof KalshiTradeError && err.status === 401 ? 502 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

/** Local order history, optionally filtered by event. */
export async function GET(req: NextRequest) {
  const eventTicker = req.nextUrl.searchParams.get("eventTicker");
  const base = db
    .select({
      id: orders.id,
      ticker: orders.ticker,
      eventTicker: orders.eventTicker,
      side: orders.side,
      count: orders.count,
      status: orders.status,
      avgFillPriceCents: orders.avgFillPriceCents,
      createdAt: orders.createdAt,
    })
    .from(orders);
  const rows = eventTicker
    ? await base.where(eq(orders.eventTicker, eventTicker)).orderBy(desc(orders.createdAt)).limit(50)
    : await base.orderBy(desc(orders.createdAt)).limit(50);
  return NextResponse.json({ orders: rows });
}
