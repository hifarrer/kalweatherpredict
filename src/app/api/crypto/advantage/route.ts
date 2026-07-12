import { NextResponse } from "next/server";
import { computeSuggestedActions, SuggestedAction } from "@/lib/suggest";
import { getOpenCryptoEventsFromDb, syncCryptoEventsIfNeeded } from "@/lib/crypto/cryptoSync";
import { buildEnrichedCryptoEvents } from "@/lib/crypto/cryptoEnrich";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 2 * 60 * 1000;
const TOP_N = 50;

export interface CryptoAdvantageRow {
  eventTicker: string;
  eventTitle: string;
  asset: string | null;
  closeTime: string;
  tauHours: number | null;
  spot: number | null;
  suggestion: SuggestedAction;
  /** Estimated profit on a $100 stake at the suggested price, after fees. */
  estProfitPer100: number;
}

let cache: { rows: CryptoAdvantageRow[]; generatedAt: string; ts: number } | null = null;

/** EV-ranked opportunities across all open crypto events (2-min cache). */
export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
      return NextResponse.json({ rows: cache.rows, generatedAt: cache.generatedAt });
    }

    await syncCryptoEventsIfNeeded();
    const dbRows = await getOpenCryptoEventsFromDb();
    const { events, contexts } = await buildEnrichedCryptoEvents(dbRows);

    const rows: CryptoAdvantageRow[] = [];
    for (const e of events) {
      if (!e.prediction) continue;
      const spot = e.asset ? contexts[e.asset]?.spot.price ?? null : null;
      for (const s of computeSuggestedActions(e, 5)) {
        const contractsPer100 = s.price > 0 ? 100 / (s.price + s.feePerContract) : 0;
        rows.push({
          eventTicker: e.event.event_ticker,
          eventTitle: e.event.title,
          asset: e.asset ?? null,
          closeTime: e.earliestClose,
          tauHours: e.prediction.tauHours ?? null,
          spot,
          suggestion: s,
          estProfitPer100: s.evPerContract * contractsPer100,
        });
      }
    }

    rows.sort((a, b) => b.suggestion.score - a.suggestion.score);
    const top = rows.slice(0, TOP_N);
    const generatedAt = new Date().toISOString();
    cache = { rows: top, generatedAt, ts: Date.now() };

    return NextResponse.json({ rows: top, generatedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Crypto advantage API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
