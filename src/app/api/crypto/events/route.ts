import { NextRequest, NextResponse } from "next/server";
import { getOpenCryptoEventsFromDb, syncCryptoEventsIfNeeded } from "@/lib/crypto/cryptoSync";
import { buildEnrichedCryptoEvents } from "@/lib/crypto/cryptoEnrich";

export const dynamic = "force-dynamic";

export type CryptoSortMode = "expiration" | "volume" | "edge";

/**
 * Open crypto events, enriched with the diffusion model's probabilities and
 * per-asset market context (spot, vols, DVOL).
 * Query params: ?asset=BTC|ETH, ?sort=expiration|volume|edge, ?refresh=1
 */
export async function GET(req: NextRequest) {
  try {
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const assetFilter = req.nextUrl.searchParams.get("asset");
    const sort = (req.nextUrl.searchParams.get("sort") || "expiration") as CryptoSortMode;

    await syncCryptoEventsIfNeeded({ force: refresh });

    let rows = await getOpenCryptoEventsFromDb();
    if (assetFilter) rows = rows.filter((r) => r.asset === assetFilter);

    const { events, contexts } = await buildEnrichedCryptoEvents(rows);

    events.sort((a, b) => {
      switch (sort) {
        case "volume":
          return b.volume24h - a.volume24h;
        case "edge":
          return Math.abs(b.maxEdge ?? 0) - Math.abs(a.maxEdge ?? 0);
        case "expiration":
        default:
          return (a.earliestClose || "").localeCompare(b.earliestClose || "");
      }
    });

    return NextResponse.json({ events, contexts, generatedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Crypto events API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
