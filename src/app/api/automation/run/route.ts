import { NextResponse } from "next/server";
import { isTradingConfigured } from "@/lib/kalshiTrade";
import { syncEventsIfNeeded } from "@/lib/sync";
import { runAutoTrade } from "@/lib/autoTrade";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manual "Run now" trigger from the automation page. Runs even while the
 * master toggle is off so the setup can be tested before going live.
 */
export async function POST() {
  if (!isTradingConfigured()) {
    return NextResponse.json(
      { error: "Kalshi trading is not configured" },
      { status: 503 },
    );
  }
  try {
    await syncEventsIfNeeded();
    const summary = await runAutoTrade("manual");
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[automation/run] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Auto-trade run failed" },
      { status: 500 },
    );
  }
}
