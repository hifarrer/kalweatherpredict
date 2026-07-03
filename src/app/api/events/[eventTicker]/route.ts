import { NextRequest, NextResponse } from "next/server";
import { getEvent } from "@/lib/kalshi";
import { detectCity } from "@/lib/cities";
import { enrichSingleEvent } from "@/lib/enrich";
import { db } from "@/db/client";
import { events } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * GET /api/events/[eventTicker]
 *
 * Fetches a SINGLE event directly from the Kalshi API (bypassing the DB cache)
 * so the user gets the very latest market prices. Also upserts the fresh data
 * back into the DB so subsequent reads are already up to date.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ eventTicker: string }> },
) {
  try {
    const { eventTicker } = await params;

    // 1. Fetch the event live from Kalshi
    const event = await getEvent(eventTicker);
    if (!event) {
      return NextResponse.json({ error: "Event not found on Kalshi" }, { status: 404 });
    }

    // 2. Detect the city, then enrich (forecast + prediction)
    const primaryRules = event.markets?.[0]?.rules_primary;
    const city = detectCity(event.title, event.series_ticker, primaryRules);
    const cityCode = city?.code ?? null;

    const enriched = await enrichSingleEvent(event, cityCode);

    // 3. Upsert fresh data into DB (fire-and-forget, non-blocking)
    db
      .insert(events)
      .values({
        eventTicker: event.event_ticker,
        seriesTicker: event.series_ticker,
        title: event.title,
        subTitle: event.sub_title || null,
        category: event.category || null,
        strikeDate: event.strike_date || null,
        cityCode,
        status: "open",
        data: event as unknown as Record<string, unknown>,
        earliestClose: enriched.earliestClose || null,
      })
      .onConflictDoUpdate({
        target: events.eventTicker,
        set: {
          seriesTicker: event.series_ticker,
          title: event.title,
          subTitle: event.sub_title || null,
          category: event.category || null,
          strikeDate: event.strike_date || null,
          cityCode,
          status: "open",
          data: event as unknown as Record<string, unknown>,
          earliestClose: enriched.earliestClose || null,
          lastUpdatedAt: new Date(),
        },
      })
      .then(() => {})
      .catch((err) =>
        console.error(`[event-refresh] DB upsert failed for ${eventTicker}:`, err),
      );

    return NextResponse.json({ event: enriched });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Single event API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
