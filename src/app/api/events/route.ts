import { NextRequest, NextResponse } from "next/server";
import {
  computeEventVolume,
  computeEventVolume24h,
  computeEarliestClose,
  SortMode,
} from "@/lib/kalshi";
import { CITY_MAP, detectMultiCity } from "@/lib/cities";
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
import { eq } from "drizzle-orm";
import { syncEventsIfNeeded, getOpenEventsFromDb } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sortParam = (req.nextUrl.searchParams.get("sort") as SortMode) || "trending";
    const sort: SortMode = ["trending", "volume", "expiration", "opportunity"].includes(sortParam)
      ? sortParam
      : "trending";
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

    // --- Sync strategy (stale-while-revalidate) ---
    //
    // If the DB has rows and this is not a force-refresh, fire the sync in the
    // background and serve cached data instantly. If the DB is empty (cold
    // start) or the user hit force-refresh, await the sync before responding.
    const openCount = await db
      .select({ ticker: events.eventTicker })
      .from(events)
      .where(eq(events.status, "open"))
      .limit(1);

    const dbHasData = openCount.length > 0;

    if (forceRefresh || !dbHasData) {
      await syncEventsIfNeeded({ force: true });
    } else {
      // Fire-and-forget background sync (non-blocking)
      syncEventsIfNeeded().catch((err) =>
        console.error("[events] background sync error:", err),
      );
    }

    // --- Read from DB ---
    const dbEvents = await getOpenEventsFromDb();

    if (dbEvents.length === 0) {
      return NextResponse.json({ events: [] });
    }

    // --- Collect city codes for forecast fetch ---
    const cityCodesNeeded: string[] = [];
    for (const row of dbEvents) {
      const multi = detectMultiCity(row.event);
      if (multi) {
        for (const c of multi.cities) {
          if (!cityCodesNeeded.includes(c.code)) cityCodesNeeded.push(c.code);
        }
      } else if (row.cityCode && !cityCodesNeeded.includes(row.cityCode)) {
        cityCodesNeeded.push(row.cityCode);
      }
    }

    const forecasts = await getForecastsForCities(cityCodesNeeded, CITY_MAP);

    // --- Build enriched events ---
    let enriched: EnrichedEvent[] = dbEvents.map(({ event: e, cityCode, earliestClose }) => {
      const multi = detectMultiCity(e);
      const prediction = multi
        ? predictMultiCityEvent(e, forecasts, multi.marketCities)
        : predictEvent(e, cityCode ? forecasts[cityCode] ?? null : null);

      return {
        event: e,
        cityCode,
        volume: computeEventVolume(e.markets),
        volume24h: computeEventVolume24h(e.markets),
        earliestClose: earliestClose || computeEarliestClose(e.markets),
        prediction,
        opportunityScore: computeOpportunityScore(e, prediction),
        subcategory: detectMetric(e),
      };
    });

    // --- Sort ---
    enriched = [...enriched];
    switch (sort) {
      case "volume":
        enriched.sort((a, b) => b.volume - a.volume);
        break;
      case "expiration":
        enriched.sort((a, b) => {
          if (!a.earliestClose) return 1;
          if (!b.earliestClose) return -1;
          return a.earliestClose.localeCompare(b.earliestClose);
        });
        break;
      case "opportunity":
        enriched.sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0));
        break;
      case "trending":
      default:
        enriched.sort((a, b) => b.volume24h - a.volume24h);
        break;
    }

    return NextResponse.json({ events: enriched });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Events API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
