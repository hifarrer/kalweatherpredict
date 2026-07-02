import { NextRequest, NextResponse } from "next/server";
import {
  computeEventVolume,
  computeEventVolume24h,
  computeEarliestClose,
  getEvent,
} from "@/lib/kalshi";
import { CITY_MAP, detectMultiCity, detectCity } from "@/lib/cities";
import { getForecastsForCities } from "@/lib/weather";
import {
  predictEvent,
  predictMultiCityEvent,
  computeOpportunityScore,
  detectMetric,
} from "@/lib/predictor";
import { EnrichedEvent } from "@/types";
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

    // 2. Detect city/cities and collect codes for forecast
    const primaryRules = event.markets?.[0]?.rules_primary;
    const city = detectCity(event.title, event.series_ticker, primaryRules);
    const cityCode = city?.code ?? null;

    const multi = detectMultiCity(event);

    const cityCodesNeeded: string[] = [];
    if (multi) {
      for (const c of multi.cities) {
        if (!cityCodesNeeded.includes(c.code)) cityCodesNeeded.push(c.code);
      }
    } else if (cityCode) {
      cityCodesNeeded.push(cityCode);
    }

    // 3. Fetch forecasts
    const forecasts = await getForecastsForCities(cityCodesNeeded, CITY_MAP);

    // 4. Compute prediction
    const prediction = multi
      ? predictMultiCityEvent(event, forecasts, multi.marketCities)
      : predictEvent(event, cityCode ? forecasts[cityCode] ?? null : null);

    // 5. Build enriched event
    const earliestClose = computeEarliestClose(event.markets);
    const enriched: EnrichedEvent = {
      event,
      cityCode,
      volume: computeEventVolume(event.markets),
      volume24h: computeEventVolume24h(event.markets),
      earliestClose,
      prediction,
      opportunityScore: computeOpportunityScore(event, prediction),
      subcategory: detectMetric(event),
    };

    // 6. Upsert fresh data into DB (fire-and-forget, non-blocking)
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
        earliestClose: earliestClose || null,
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
          earliestClose: earliestClose || null,
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
