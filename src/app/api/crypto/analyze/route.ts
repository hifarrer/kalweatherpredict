import { NextRequest, NextResponse } from "next/server";
import { isAiConfigured } from "@/lib/analyze";
import { enrichSingleCryptoEvent } from "@/lib/crypto/cryptoEnrich";
import { analyzeCryptoEvent } from "@/lib/crypto/cryptoAnalyze";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!isAiConfigured()) {
      return NextResponse.json(
        { error: "AI analysis is not configured. Set ANTHROPIC_API_KEY and restart." },
        { status: 503 },
      );
    }

    const body = await req.json();
    const eventTicker: string = body?.eventTicker;
    if (!eventTicker) {
      return NextResponse.json({ error: "eventTicker is required" }, { status: 400 });
    }

    const single = await enrichSingleCryptoEvent(eventTicker);
    if (!single) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const result = await analyzeCryptoEvent(single.enriched, single.context);
    return NextResponse.json(result);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("Crypto analyze API error:", err);
    const isNetwork = /premature close|fetch failed|econnreset|etimedout|socket hang up|aborted/i.test(
      rawMessage,
    );
    return NextResponse.json(
      { error: isNetwork ? "The AI service connection was interrupted. Please try again." : rawMessage },
      { status: 500 },
    );
  }
}
