import { NextRequest, NextResponse } from "next/server";
import { isTradingConfigured } from "@/lib/kalshiTrade";
import { syncCryptoEventsIfNeeded } from "@/lib/crypto/cryptoSync";
import { runCryptoAutoTrade } from "@/lib/crypto/cryptoAutoTrade";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // AI reviews + order placement can take a while

/**
 * External-cron trigger for the crypto automation engine.
 *
 * Exempt from the session gate in proxy.ts; authenticated instead by a shared
 * secret (?secret=... or x-cron-secret header) compared against CRON_SECRET.
 * Hourly ladders move fast — point an external cron service at this every
 * 5 minutes:
 *   GET https://<host>/api/cron/crypto-auto-trade?secret=<CRON_SECRET>
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — refusing to run" },
      { status: 503 },
    );
  }
  const provided =
    req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-cron-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isTradingConfigured()) {
    return NextResponse.json(
      { error: "Kalshi trading is not configured" },
      { status: 503 },
    );
  }

  try {
    await syncCryptoEventsIfNeeded();
    const summary = await runCryptoAutoTrade("cron");
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[cron/crypto-auto-trade] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Crypto auto-trade run failed" },
      { status: 500 },
    );
  }
}
