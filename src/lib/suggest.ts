import { EnrichedEvent, KalshiMarket, MetricKind } from "@/types";

/** Minimum 24h volume for a market to be suggestible (matches EDGE_MIN_VOLUME). */
export const SUGGEST_MIN_VOLUME = 100;
/** Minimum fee-adjusted expected value per contract (dollars) for a "value" pick. */
export const SUGGEST_MIN_EV = 0.05;
/** Minimum blended win probability for a "value" pick — filters longshot tail bets. */
export const SUGGEST_MIN_WINPROB = 0.15;
/** Consensus picks must be at least breakeven after fees. */
export const CONSENSUS_MIN_EV = 0.0;

// --- Model/market probability blending -------------------------------------
/** Base trust in our forecast model vs the market price. */
export const BLEND_MODEL_WEIGHT = 0.65;
/** Market extremity below which model weight shrinks toward the market. */
export const BLEND_TAIL_FULL = 0.1;
/** Floor on the tail factor — the model always keeps some influence. */
export const BLEND_TAIL_MIN = 0.25;
/** Model-market disagreement (probability points) where the penalty starts. */
export const BLEND_DISAGREE_START = 0.25;
/** Disagreement at which the penalty is fully applied. */
export const BLEND_DISAGREE_END = 0.5;
/** Floor on the disagreement factor. */
export const BLEND_DISAGREE_MIN = 0.5;
/** 24h volume above which the market price gets extra trust. */
export const BLEND_HIGH_VOLUME = 2000;
export const BLEND_HIGH_VOLUME_FACTOR = 0.8;

export interface SuggestedAction {
  ticker: string;
  marketTitle: string;
  strike: string | null;
  side: "yes" | "no";
  /** Ask price for the suggested side, in dollars (what you'd pay). */
  price: number;
  forecastProb: number; // raw model P(YES) from the forecast
  /** Model P(YES) blended with the market-implied probability. */
  blendedProb: number;
  /** Blended probability that the suggested side wins. */
  winProb: number;
  marketProb: number | null;
  /** Kalshi taker fee per contract at this price, in dollars. */
  feePerContract: number;
  /** Expected value per contract in dollars at the ask, net of fees. */
  evPerContract: number;
  /** Risk-adjusted ranking score: evPerContract × sqrt(winProb). */
  score: number;
  kind: "consensus" | "value";
  rationale: string;
  volume24h: number;
}

/**
 * Kalshi taker fee per contract: ceil-to-cent of 0.07 × price × (1 − price).
 * Kalshi's published formula ceils over the whole order; per-contract ceiling
 * is the conservative approximation. Examples: 50¢ → 2¢, 1¢ → 1¢.
 */
export function kalshiFeePerContract(price: number): number {
  return Math.ceil(0.07 * price * (1 - price) * 100) / 100;
}

/**
 * Blend the model's P(YES) with the market-implied P(YES).
 *
 * The model's Gaussian tails are its least reliable region, while an extreme
 * market price (1¢ / 99¢) is many informed traders saying the tail is dead.
 * Model weight w shrinks when the market is extreme, when model and market
 * disagree wildly, and when the market is high-volume. Observation-decided
 * outcomes trust the model fully.
 *
 * `obsBacked` probabilities (same-day, blended with official station
 * observations) skip the tail/disagreement shrinkage: they are arithmetic on
 * observed facts, not Gaussian-tail artifacts, and a huge gap vs the market
 * usually means the market hasn't priced in today's observations yet.
 */
export function blendProbability(
  pModel: number,
  pMarket: number | null,
  vol24h: number,
  decided: boolean,
  obsBacked = false,
): { pBlend: number; w: number } {
  if (decided || pMarket == null) return { pBlend: pModel, w: 1 };

  const volFactor = vol24h >= BLEND_HIGH_VOLUME ? BLEND_HIGH_VOLUME_FACTOR : 1;

  if (obsBacked) {
    const w = BLEND_MODEL_WEIGHT * volFactor;
    return { pBlend: w * pModel + (1 - w) * pMarket, w };
  }

  const extremity = Math.min(pMarket, 1 - pMarket);
  const tailFactor = Math.min(1, Math.max(BLEND_TAIL_MIN, extremity / BLEND_TAIL_FULL));

  const d = Math.abs(pModel - pMarket);
  const disagreeFactor =
    d <= BLEND_DISAGREE_START
      ? 1
      : Math.max(
          BLEND_DISAGREE_MIN,
          1 -
            ((d - BLEND_DISAGREE_START) / (BLEND_DISAGREE_END - BLEND_DISAGREE_START)) *
              (1 - BLEND_DISAGREE_MIN),
        );

  const w = BLEND_MODEL_WEIGHT * tailFactor * disagreeFactor * volFactor;
  return { pBlend: w * pModel + (1 - w) * pMarket, w };
}

/**
 * Market-implied P(YES) usable for blending: the likelihood's marketProb when
 * it's a real price, else the yes bid/ask midpoint, else null (no blending).
 */
function blendableMarketProb(marketProb: number | null | undefined, m: KalshiMarket): number | null {
  if (marketProb != null && marketProb > 0.005 && marketProb < 0.995) return marketProb;
  const yesBid = parseFloat(m.yes_bid_dollars || "0");
  const yesAsk = parseFloat(m.yes_ask_dollars || "0");
  if (yesBid > 0 && yesAsk > 0 && yesAsk < 1) return (yesBid + yesAsk) / 2;
  return null;
}

/**
 * Compute suggested actions for one enriched event.
 *
 * Two families of picks, deduped by (ticker, side), capped at `cap`:
 * - consensus: the buckets closest to the forecast point value
 * - value: highest fee-adjusted, risk-weighted expected value at the current ask
 */
export function computeSuggestedActions(
  enriched: EnrichedEvent,
  cap = 5,
): SuggestedAction[] {
  const { event, prediction } = enriched;
  const likelihoods = prediction?.marketLikelihoods;
  if (!event.markets || !likelihoods || likelihoods.length === 0) return [];

  const marketByTicker = new Map(event.markets.map((m) => [m.ticker, m]));
  const unit = metricUnit(enriched.subcategory);

  const candidates: SuggestedAction[] = [];

  for (const ll of likelihoods) {
    const m = marketByTicker.get(ll.ticker);
    if (!m) continue;
    const vol24 = parseFloat(m.volume_24h_fp || "0");
    if (vol24 < SUGGEST_MIN_VOLUME) continue;

    const yesAsk = parseFloat(m.yes_ask_dollars || "0");
    const noAsk = parseFloat(m.no_ask_dollars || "0");
    const p = ll.probability;
    const pMarket = blendableMarketProb(ll.marketProb, m);
    const { pBlend, w } = blendProbability(
      p,
      pMarket,
      vol24,
      ll.decided === true,
      ll.obsBacked === true,
    );

    // EV of buying each side at its ask. Skip sides with no book (ask 0/1).
    for (const side of ["yes", "no"] as const) {
      const ask = side === "yes" ? yesAsk : noAsk;
      if (ask <= 0.005 || ask >= 0.995) continue;
      const winProb = side === "yes" ? pBlend : 1 - pBlend;
      // Skip sides the same-day observations have already decided against
      if (ll.decided && winProb < 0.5) continue;

      const modelWin = side === "yes" ? p : 1 - p;
      const fee = kalshiFeePerContract(ask);
      const ev = winProb - ask - fee;

      const marketPart =
        pMarket != null
          ? ` / market ${Math.round((side === "yes" ? pMarket : 1 - pMarket) * 100)}%`
          : "";
      const blendNote = ll.obsBacked
        ? " Model probability incorporates today's official station observations."
        : pMarket != null && w <= 0.35
          ? ` (model weight cut to ${Math.round(w * 100)}% — market price is near an extreme)`
          : "";
      const rationale = `Model ${Math.round(modelWin * 100)}%${marketPart} → blended ${Math.round(
        winProb * 100,
      )}% ${side.toUpperCase()} win vs ${Math.round(ask * 100)}¢ ask + ${Math.round(
        fee * 100,
      )}¢ fee → ${ev >= 0 ? "+" : ""}${Math.round(ev * 100)}¢ net EV per contract.${blendNote}`;

      candidates.push({
        ticker: m.ticker,
        marketTitle: m.yes_sub_title || m.ticker,
        strike: null,
        side,
        price: ask,
        forecastProb: p,
        blendedProb: pBlend,
        winProb,
        marketProb: pMarket,
        feePerContract: fee,
        evPerContract: ev,
        score: ev * Math.sqrt(Math.max(0, winProb)),
        kind: "value",
        rationale,
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

  // Keep: consensus picks at breakeven-or-better, value picks above the EV
  // floor with a real chance of winning (no positive-EV longshot lottery tickets)
  const kept = candidates.filter((c) =>
    c.kind === "consensus"
      ? c.evPerContract >= CONSENSUS_MIN_EV
      : c.evPerContract >= SUGGEST_MIN_EV && c.winProb >= SUGGEST_MIN_WINPROB,
  );

  // Dedupe by ticker+side (consensus wins), sort by risk-adjusted score, cap
  const seen = new Set<string>();
  const deduped: SuggestedAction[] = [];
  for (const c of [...kept].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "consensus" ? -1 : 1;
    return b.score - a.score;
  })) {
    const key = `${c.ticker}:${c.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  return deduped.sort((a, b) => b.score - a.score).slice(0, cap);
}

/** Display unit for a metric kind, used in consensus rationale text. */
function metricUnit(metric: MetricKind): string {
  if (metric === "crypto_price") return "$";
  if (metric === "precipitation" || metric === "snowfall") return '"';
  return "°F";
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
