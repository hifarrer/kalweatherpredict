import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { events, orders, suggestions } from "@/db/schema";
import {
  createOrder,
  isTradingConfigured,
  maxOrderContracts,
  KalshiTradeError,
} from "@/lib/kalshiTrade";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { KalshiEvent } from "@/types";

export const dynamic = "force-dynamic";

const MAX_COST_BUFFER_CENTS = 5; // per contract, on top of the quoted ask

/**
 * Snapshot of the AI suggestion the user acted on, sent by the trade modal.
 * Client-supplied and audit-only: numbers are stored for later grading, never
 * used to price or validate the order itself.
 */
interface OrderSuggestionPayload {
  side?: string;
  kind?: string;
  price?: number;
  forecastProb?: number;
  blendedProb?: number;
  winProb?: number;
  marketProb?: number | null;
  feePerContract?: number;
  evPerContract?: number;
  score?: number;
  volume24h?: number;
  metric?: string | null;
  targetDate?: string | null;
  leadDays?: number | null;
  aiVerdict?: string | null;
  aiConfidence?: number | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Shape-check the suggestion payload; returns null if anything vital is off. */
function validSuggestion(
  s: OrderSuggestionPayload | undefined,
  orderSide: string,
): OrderSuggestionPayload | null {
  if (!s || typeof s !== "object") return null;
  if (s.side !== orderSide) return null; // stale/mismatched card — don't link
  if (s.kind !== "consensus" && s.kind !== "value") return null;
  const required = [
    s.price,
    s.forecastProb,
    s.blendedProb,
    s.winProb,
    s.feePerContract,
    s.evPerContract,
    s.score,
  ];
  if (!required.every(isFiniteNumber)) return null;
  return s;
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
    suggestion?: OrderSuggestionPayload;
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
    .select({
      data: events.data,
      cityCode: events.cityCode,
      section: events.section,
      asset: events.asset,
    })
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

  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const payload = session ? await verifySessionToken(session) : null;
  const userId = payload ? parseInt(payload.sub, 10) : NaN;

  // Snapshot the suggestion the user acted on, so the order can later be
  // graded against what the AI claimed at buy time. Best-effort: a failure
  // here must never block the real order.
  let suggestionId: number | null = null;
  const sugg = validSuggestion(body.suggestion, side);
  if (sugg) {
    try {
      const [row] = await db
        .insert(suggestions)
        .values({
          eventTicker,
          marketTicker: ticker,
          side,
          kind: sugg.kind!,
          source: "order",
          price: sugg.price!,
          forecastProb: sugg.forecastProb!,
          blendedProb: sugg.blendedProb!,
          winProb: sugg.winProb!,
          marketProb: isFiniteNumber(sugg.marketProb) ? sugg.marketProb : null,
          feePerContract: sugg.feePerContract!,
          evPerContract: sugg.evPerContract!,
          score: sugg.score!,
          volume24h: isFiniteNumber(sugg.volume24h) ? sugg.volume24h : null,
          cityCode: rows[0]?.cityCode ?? null,
          section: rows[0]?.section ?? "weather",
          asset: rows[0]?.asset ?? null,
          metric: typeof sugg.metric === "string" ? sugg.metric : null,
          targetDate: typeof sugg.targetDate === "string" ? sugg.targetDate : null,
          leadDays: isFiniteNumber(sugg.leadDays) ? sugg.leadDays : null,
          aiVerdict: typeof sugg.aiVerdict === "string" ? sugg.aiVerdict : null,
          aiConfidence: isFiniteNumber(sugg.aiConfidence) ? sugg.aiConfidence : null,
        })
        .returning({ id: suggestions.id });
      suggestionId = row?.id ?? null;
    } catch (err) {
      console.error("Failed to snapshot order suggestion:", err);
    }
  }

  const clientOrderId = randomUUID();
  const maxPriceCents = askCents! + MAX_COST_BUFFER_CENTS;

  // Audit row first (idempotency anchor), then the Kalshi call.
  const [orderRow] = await db
    .insert(orders)
    .values({
      clientOrderId,
      userId: Number.isFinite(userId) ? userId : null,
      ticker,
      eventTicker,
      side,
      action: "buy",
      type: "market", // emulated: immediate-or-cancel at ask + buffer
      count: count!,
      maxCostCents: count! * maxPriceCents,
      status: "pending",
      section: rows[0]?.section ?? "weather",
      suggestionId,
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
        fillCount: placed.fillCount,
        avgFeeCents: placed.avgFeeCents,
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
