import { EnrichedEvent, KalshiMarket } from "@/types";

/** Minimum 24h volume for a market to be suggestible (matches EDGE_MIN_VOLUME). */
export const SUGGEST_MIN_VOLUME = 100;
/** Minimum expected value per contract (dollars) for a "value" pick. */
export const SUGGEST_MIN_EV = 0.05;

export interface SuggestedAction {
  ticker: string;
  marketTitle: string;
  strike: string | null;
  side: "yes" | "no";
  /** Ask price for the suggested side, in dollars (what you'd pay). */
  price: number;
  forecastProb: number; // P(YES) from the forecast model
  marketProb: number | null;
  /** Expected value per contract in dollars at the ask. */
  evPerContract: number;
  kind: "consensus" | "value";
  rationale: string;
  volume24h: number;
}

/**
 * Compute suggested actions for one enriched event.
 *
 * Two families of picks, deduped by (ticker, side), capped at `cap`:
 * - consensus: the buckets closest to the forecast point value
 * - value: highest expected value at the current ask
 */
export function computeSuggestedActions(
  enriched: EnrichedEvent,
  cap = 5,
): SuggestedAction[] {
  const { event, prediction } = enriched;
  const likelihoods = prediction?.marketLikelihoods;
  if (!event.markets || !likelihoods || likelihoods.length === 0) return [];

  const marketByTicker = new Map(event.markets.map((m) => [m.ticker, m]));
  const unit =
    enriched.subcategory === "precipitation" || enriched.subcategory === "snowfall"
      ? '"'
      : "°F";

  const candidates: SuggestedAction[] = [];

  for (const ll of likelihoods) {
    const m = marketByTicker.get(ll.ticker);
    if (!m) continue;
    const vol24 = parseFloat(m.volume_24h_fp || "0");
    if (vol24 < SUGGEST_MIN_VOLUME) continue;

    const yesAsk = parseFloat(m.yes_ask_dollars || "0");
    const noAsk = parseFloat(m.no_ask_dollars || "0");
    const p = ll.probability;

    // EV of buying each side at its ask. Skip sides with no book (ask 0/1).
    for (const side of ["yes", "no"] as const) {
      const ask = side === "yes" ? yesAsk : noAsk;
      if (ask <= 0.005 || ask >= 0.995) continue;
      const winProb = side === "yes" ? p : 1 - p;
      // Skip sides the same-day observations have already decided against
      if (ll.decided && winProb < 0.5) continue;
      const ev = winProb - ask;

      candidates.push({
        ticker: m.ticker,
        marketTitle: m.yes_sub_title || m.ticker,
        strike: null,
        side,
        price: ask,
        forecastProb: p,
        marketProb: ll.marketProb ?? null,
        evPerContract: ev,
        kind: "value",
        rationale: `Forecast gives ${side.toUpperCase()} ${Math.round(winProb * 100)}% vs ${Math.round(
          ask * 100,
        )}¢ ask → ${ev >= 0 ? "+" : ""}${Math.round(ev * 100)}¢ expected value per contract.`,
        volume24h: vol24,
      });
    }
  }

  // --- Consensus picks: buckets nearest the forecast point value ---
  const fv = prediction?.forecastValue;
  const consensusTickers = new Set<string>();
  if (fv != null) {
    const withDistance = event.markets
      .filter((m) => {
        const vol24 = parseFloat(m.volume_24h_fp || "0");
        return vol24 >= SUGGEST_MIN_VOLUME && strikeDistance(m, fv) !== null;
      })
      .map((m) => ({ m, dist: strikeDistance(m, fv)! }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    for (const { m } of withDistance) consensusTickers.add(m.ticker);
  }

  // Promote consensus candidates (YES side of the nearest buckets)
  for (const c of candidates) {
    if (c.side === "yes" && consensusTickers.has(c.ticker)) {
      c.kind = "consensus";
      c.rationale = `One of the ${consensusTickers.size} answers closest to the ${fv}${unit} consensus forecast. ${c.rationale}`;
    }
  }

  // Keep: all consensus picks + value picks above the EV floor
  const kept = candidates.filter(
    (c) => c.kind === "consensus" || c.evPerContract >= SUGGEST_MIN_EV,
  );

  // Dedupe by ticker+side (consensus wins), sort EV desc, cap
  const seen = new Set<string>();
  const deduped: SuggestedAction[] = [];
  for (const c of [...kept].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "consensus" ? -1 : 1;
    return b.evPerContract - a.evPerContract;
  })) {
    const key = `${c.ticker}:${c.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  return deduped
    .sort((a, b) => b.evPerContract - a.evPerContract)
    .slice(0, cap);
}

/** Distance from a forecast value to a market's strike center; null if no strikes. */
function strikeDistance(m: KalshiMarket, forecastValue: number): number | null {
  const { floor_strike: floor, cap_strike: capS } = m;
  switch (m.strike_type) {
    case "between":
      if (floor !== null && capS !== null) {
        return Math.abs((floor + capS) / 2 - forecastValue);
      }
      return null;
    case "greater":
    case "greater_or_equal":
      return floor !== null ? Math.abs(floor - forecastValue) : null;
    case "less":
    case "less_or_equal":
      return capS !== null ? Math.abs(capS - forecastValue) : null;
    default:
      return null;
  }
}
