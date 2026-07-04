import Anthropic from "@anthropic-ai/sdk";
import { getOpenEventsFromDb } from "@/lib/sync";
import { buildEnrichedEvents } from "@/lib/enrich";
import { computeSuggestedActions, SUGGEST_MIN_EV } from "@/lib/suggest";
import { KalshiMarket } from "@/types";

/**
 * The AI Advantage scan: EV-ranked opportunities across every open event.
 *
 * The ranking itself is pure math (forecast probability vs ask price);
 * Claude only writes an optional narrative summary over the top rows.
 */

export interface AdvantageRow {
  eventTicker: string;
  eventTitle: string;
  cityCode: string | null;
  subcategory: string;
  marketTicker: string;
  marketTitle: string;
  side: "yes" | "no";
  /** Ask price in dollars for the suggested side. */
  price: number;
  forecastProb: number;
  /** Model P(YES) blended with the market-implied probability. */
  blendedProb: number;
  /** Blended probability that the suggested side wins. */
  winProb: number;
  marketProb: number | null;
  /** Kalshi taker fee per contract at this price, in dollars. */
  feePerContract: number;
  /** Expected value per contract in dollars, net of fees. */
  evPerContract: number;
  /** Risk-adjusted ranking score: evPerContract × sqrt(winProb). */
  score: number;
  /** Expected profit on a $100 stake at this price/probability, net of fees. */
  estProfitPer100: number;
  kind: "consensus" | "value";
  rationale: string;
  closeTime: string;
  volume24h: number;
  leadDays: number | null;
  /** Full market object so the UI can open the trade modal directly. */
  market: KalshiMarket;
}

export interface AdvantageScan {
  rows: AdvantageRow[];
  eventsScanned: number;
  generatedAt: string;
}

const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
let scanCache: { data: AdvantageScan; ts: number } | null = null;

export async function getAdvantageScan(force = false): Promise<AdvantageScan> {
  const now = Date.now();
  if (!force && scanCache && now - scanCache.ts < SCAN_CACHE_TTL_MS) {
    return scanCache.data;
  }

  const dbRows = await getOpenEventsFromDb();
  const enriched = await buildEnrichedEvents(dbRows);

  const rows: AdvantageRow[] = [];
  for (const e of enriched) {
    const marketByTicker = new Map(
      (e.event.markets ?? []).map((m) => [m.ticker, m]),
    );
    // Uncapped per-event suggestions; global filter + sort below
    const suggestions = computeSuggestedActions(e, 10);
    for (const s of suggestions) {
      // Value picks need the (fee-adjusted) EV floor; consensus picks only breakeven
      if (s.kind === "value" && s.evPerContract < SUGGEST_MIN_EV) continue;
      if (s.kind === "consensus" && s.evPerContract < 0) continue;
      const market = marketByTicker.get(s.ticker);
      if (!market) continue;
      if (market.close_time && new Date(market.close_time).getTime() <= now) continue;

      // $100 stake buys 100/price contracts; each pays $1 with the blended
      // win probability, minus the taker fee per contract
      const contractsPer100 = 100 / s.price;
      const estProfitPer100 =
        contractsPer100 * s.winProb - 100 - contractsPer100 * s.feePerContract;

      rows.push({
        eventTicker: e.event.event_ticker,
        eventTitle: e.event.title,
        cityCode: e.cityCode,
        subcategory: e.subcategory,
        marketTicker: s.ticker,
        marketTitle: s.marketTitle,
        side: s.side,
        price: s.price,
        forecastProb: s.forecastProb,
        blendedProb: s.blendedProb,
        winProb: s.winProb,
        marketProb: s.marketProb,
        feePerContract: s.feePerContract,
        evPerContract: s.evPerContract,
        score: s.score,
        estProfitPer100: Math.round(estProfitPer100 * 100) / 100,
        kind: s.kind,
        rationale: s.rationale,
        closeTime: market.close_time,
        volume24h: s.volume24h,
        leadDays: e.prediction?.leadDays ?? null,
        market,
      });
    }
  }

  rows.sort((a, b) => b.score - a.score);

  const scan: AdvantageScan = {
    rows: rows.slice(0, 50),
    eventsScanned: enriched.length,
    generatedAt: new Date().toISOString(),
  };
  scanCache = { data: scan, ts: now };
  return scan;
}

// --- Claude narrative summary over the top opportunities ---

const SUMMARY_CACHE_TTL_MS = 30 * 60 * 1000;
let summaryCache: { text: string; scanGeneratedAt: string; ts: number } | null = null;

export async function getAdvantageSummary(scan: AdvantageScan): Promise<string> {
  const now = Date.now();
  if (
    summaryCache &&
    summaryCache.scanGeneratedAt === scan.generatedAt &&
    now - summaryCache.ts < SUMMARY_CACHE_TTL_MS
  ) {
    return summaryCache.text;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const anthropic = new Anthropic({ apiKey, maxRetries: 3, timeout: 60_000 });

  const top = scan.rows.slice(0, 15);
  const rowsText = top
    .map(
      (r, i) =>
        `${i + 1}. ${r.eventTitle} — "${r.marketTitle}" — buy ${r.side.toUpperCase()} @ ${Math.round(
          r.price * 100,
        )}¢ | model ${Math.round(r.forecastProb * 100)}% YES, blended w/ market ${Math.round(
          r.blendedProb * 100,
        )}% | net EV +${Math.round(
          r.evPerContract * 100,
        )}¢/contract after fees | closes ${r.closeTime} | lead ${r.leadDays ?? "?"}d | city ${r.cityCode ?? "?"} | 24h vol ${Math.round(r.volume24h)}`,
    )
    .join("\n");

  const response = await anthropic.messages.create({
    model: process.env.ANALYZE_MODEL || "claude-sonnet-4-5",
    max_tokens: 800,
    system:
      "You are a prediction-market trading analyst. Work ONLY from the data provided — do not use web search or outside real-time information. The expected values come from multi-model weather-forecast probabilities blended with market-implied probabilities, compared to current Kalshi ask prices, net of taker fees.",
    messages: [
      {
        role: "user",
        content: `Here are today's top expected-value opportunities in Kalshi weather markets, ranked by EV per contract:\n\n${rowsText}\n\nWrite a concise 2-3 paragraph briefing: (1) which plays look strongest and why, (2) correlated-risk warnings — e.g. multiple picks that share one city/forecast and would all lose together on a single forecast miss, (3) anything that looks too good to be true (stale prices, thin volume). Plain text, no markdown headers.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  summaryCache = { text, scanGeneratedAt: scan.generatedAt, ts: now };
  return text;
}
