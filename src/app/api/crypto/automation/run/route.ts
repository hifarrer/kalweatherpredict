import { NextResponse } from "next/server";
import { runCryptoAutoTrade } from "@/lib/crypto/cryptoAutoTrade";
import { syncCryptoEventsIfNeeded } from "@/lib/crypto/cryptoSync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manual "Run now" — executes even while the master toggle is off (testing). */
export async function POST() {
  try {
    await syncCryptoEventsIfNeeded();
    const summary = await runCryptoAutoTrade("manual");
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Crypto automation run error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
