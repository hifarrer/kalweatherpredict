import { NextRequest, NextResponse } from "next/server";
import { CITY_MAP } from "@/lib/cities";
import { getForecastsForCities } from "@/lib/weather";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const citiesParam = req.nextUrl.searchParams.get("cities") || "";
    const cityCodes = citiesParam
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);

    if (cityCodes.length === 0) {
      return NextResponse.json({ forecasts: {} });
    }

    const forecasts = await getForecastsForCities(cityCodes, CITY_MAP);
    return NextResponse.json({ forecasts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Weather API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
