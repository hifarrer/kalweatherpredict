import { NextRequest, NextResponse } from "next/server";
import { getEvent } from "@/lib/kalshi";
import { detectCity, CITY_MAP } from "@/lib/cities";
import { getForecast } from "@/lib/weather";
import { analyzeEvent, isAiConfigured } from "@/lib/analyze";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!isAiConfigured()) {
      return NextResponse.json(
        {
          error:
            "AI analysis is not configured. Set ANTHROPIC_API_KEY in .env.local and restart the dev server.",
        },
        { status: 503 },
      );
    }

    const body = await req.json();
    const eventTicker: string = body?.eventTicker;

    if (!eventTicker) {
      return NextResponse.json({ error: "eventTicker is required" }, { status: 400 });
    }

    // 1. Fetch the event with markets
    const event = await getEvent(eventTicker);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // 2. Detect city and fetch forecast
    const primaryRules = event.markets?.[0]?.rules_primary;
    const city = detectCity(event.title, event.series_ticker, primaryRules);
    const forecast = city ? await getForecast(city) : null;

    // 3. Run AI analysis
    const result = await analyzeEvent(event, forecast);

    return NextResponse.json(result);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("Analyze API error:", err);

    // Surface a friendlier message for transient network failures
    const isNetwork = /premature close|fetch failed|econnreset|etimedout|socket hang up|aborted/i.test(
      rawMessage,
    );
    const message = isNetwork
      ? "The AI service connection was interrupted. Please try again."
      : rawMessage;

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
