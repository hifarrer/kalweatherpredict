import Anthropic from "@anthropic-ai/sdk";
import { EnrichedEvent } from "@/types";
import { getClient, callWithRetry } from "@/lib/analyze";
import { parseReview, SuggestionReview } from "@/lib/review";
import { computeSuggestedActions, SuggestedAction } from "@/lib/suggest";
import { CryptoAssetContext } from "@/lib/crypto/cryptoEnrich";

/**
 * Skeptical AI review of the algorithmic suggestions for one crypto event —
 * the crypto counterpart of review.ts and, like it, the mandatory gate the
 * auto-trader runs before buying. Same JSON contract, same cache pattern.
 */

const REVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const reviewCache = new Map<
  string,
  { review: SuggestionReview; suggestionsKey: string; ts: number }
>();

function suggestionsKey(suggestions: SuggestedAction[]): string {
  return suggestions.map((s) => `${s.ticker}:${s.side}:${s.price}`).join("|");
}

export async function reviewCryptoSuggestions(
  enriched: EnrichedEvent,
  ctx: CryptoAssetContext | null,
): Promise<SuggestionReview> {
  const { event, prediction } = enriched;

  // Recompute server-side — never trust client-posted numbers
  const suggestions = computeSuggestedActions(enriched, 10);
  if (suggestions.length === 0) {
    return {
      verdicts: [],
      overall: "No suggestions to review for this event.",
      generatedAt: new Date().toISOString(),
    };
  }

  const key = suggestionsKey(suggestions);
  const cached = reviewCache.get(event.event_ticker);
  if (cached && cached.suggestionsKey === key && Date.now() - cached.ts < REVIEW_CACHE_TTL_MS) {
    return cached.review;
  }

  const anthropic = getClient();

  const tauMin =
    prediction?.tauHours !== undefined ? Math.round(prediction.tauHours * 60) : null;
  const spotAgeSec = ctx ? Math.round((Date.now() - ctx.spot.ts) / 1000) : null;

  const marketDataInfo = ctx
    ? `Live spot: $${ctx.spot.price.toLocaleString("en-US")} via ${ctx.spot.source} (fetched ${spotAgeSec}s ago — treat as CURRENT, not stale)
Realized vol (annualized): 30m ${pct(ctx.rvs.rv30m)}, 2h ${pct(ctx.rvs.rv2h)}, 8h ${pct(ctx.rvs.rv8h)}, 24h ${pct(ctx.rvs.rv24h)}
Implied vol (Deribit DVOL): ${pct(ctx.dvol)}`
    : "No live market data available.";

  const predictionInfo = prediction
    ? `Model: drift-free log-normal diffusion around live spot.
${prediction.detail}
Time to settlement: ${tauMin ?? "?"} minutes
Log-space σ over the remaining horizon (σ·√τ): ${prediction.sigma !== undefined ? (prediction.sigma * 100).toFixed(2) + "%" : "N/A"}`
    : "No model prediction available.";

  const semantics = `MARKET SEMANTICS (get the direction right):
- These markets settle on the asset's PRICE AT ONE INSTANT (the stated settlement time, via the CF Benchmarks reference rate — the live spot above is a close proxy). This is NOT a running max/min: the price can move either way until the very last second.
- "X or above" (strike_type greater, floor=X) wins YES iff settlement price > X. A "between" market wins YES iff floor ≤ price ≤ cap.
- The expected move over the remaining minutes is roughly spot × σ√τ (given above). Strikes many expected-moves away from spot are effectively decided; strikes within one expected move are genuine coin flips regardless of what the book says.
- PAYOFF: every contract pays $1.00 if the bought side wins, $0 otherwise. Net EV per contract already subtracts the ask and the Kalshi fee.`;

  const marketByTicker = new Map((event.markets ?? []).map((m) => [m.ticker, m]));
  const suggestionsText = suggestions
    .map((s, i) => {
      const m = marketByTicker.get(s.ticker);
      const strike = m?.strike_type
        ? ` [YES wins iff settlement price is ${m.strike_type}: floor=${m.floor_strike ?? "N/A"}, cap=${m.cap_strike ?? "N/A"}]`
        : "";
      return `  ${i + 1}. BUY ${s.side.toUpperCase()} "${s.marketTitle}"${strike} (${s.ticker}) @ ${Math.round(
          s.price * 100,
        )}¢ | model win ${Math.round(
          (s.side === "yes" ? s.forecastProb : 1 - s.forecastProb) * 100,
        )}% | blended win ${Math.round(s.winProb * 100)}% | market P(YES) ${
          s.marketProb != null ? `${Math.round(s.marketProb * 100)}%` : "?"
        } | fee ${Math.round(s.feePerContract * 100)}¢ | net EV ${
          s.evPerContract >= 0 ? "+" : ""
        }${Math.round(s.evPerContract * 100)}¢ | ${s.kind} | 24h vol ${Math.round(s.volume24h)}`;
    })
    .join("\n");

  const userPrompt = `You are reviewing algorithmic trade suggestions for a Kalshi crypto price market. Work ONLY from the data below — no web search or outside real-time information.

EVENT: ${event.title}
SUB-TITLE: ${event.sub_title}

LIVE MARKET DATA:
${marketDataInfo}

APP PREDICTION MODEL SUMMARY:
${predictionInfo}

${semantics}

ALGORITHMIC SUGGESTIONS TO REVIEW:
${suggestionsText}

Act as a skeptical trading-desk reviewer. For EACH suggestion, judge whether the SUGGESTED SIDE will win at settlement:
- "keep": the numbers hold up — the suggested side is favored and the price offers real edge
- "downgrade": playable but weaker than the numbers imply (thin volume, vol-regime ambiguity, a strike within one expected move of spot being treated as near-certain, or a too-good-to-be-true concern you cannot resolve from the data)
- "veto": the suggested side would likely LOSE — spot and the remaining time contradict it (e.g. buying NO on a strike the spot already comfortably exceeds with minutes left, or buying YES on a strike several expected moves away)

Important context:
- The spot price above is live and authoritative — do NOT assume it is stale.
- Kalshi crypto books are retail-heavy and near settlement they often lag a fast spot move. A large model-vs-market gap on a market settling within ~30 minutes, when spot is already several expected moves past the strike, is a common and genuine edge — that is exactly what this tool hunts for. Do not veto a pick merely because the edge looks too large; veto only when spot + remaining time contradict the suggested side itself.
- Watch for: suggestions whose edge relies on σ being right when the 30m realized vol is far above the 24h vol (vol spike — the expected move may be badly underestimated); longshot picks on strikes within one expected move; and books so thin the posted ask may not be fillable.

For each suggestion, work through these steps IN ORDER and record them in the JSON:
1. "winCondition": what settlement price makes the SUGGESTED side (YES or NO as listed) win? Derive it from the strike spec. E.g. for BUY YES on [greater: floor=64199.99] → "settlement price > 64199.99"; for BUY NO on the same market → "settlement price <= 64199.99".
2. "estFinalValue": your best estimate of the settlement price (start from live spot; the expected move is spot × σ√τ).
3. "sideWins": does the estFinalValue satisfy the winCondition — "likely", "unlikely", or "uncertain"? A strike within one expected move of spot is "uncertain" no matter how it is priced.
4. "verdict" MUST be consistent with sideWins: "likely" → keep (downgrade only for liquidity/data-quality concerns); "unlikely" → veto; "uncertain" → downgrade.

Format your response EXACTLY as this JSON (no markdown fences, no extra text). Keep each reason to ONE short sentence:
{
  "verdicts": [
    { "ticker": "<market ticker>", "side": "yes|no", "winCondition": "<step 1>", "estFinalValue": <step 2, number>, "sideWins": "likely|unlikely|uncertain", "verdict": "keep|downgrade|veto", "confidence": 0.0, "reason": "<one short sentence>" }
  ],
  "overall": "<1-2 sentence overall take on this event's suggestions>"
}`;

  const response = await callWithRetry(() =>
    anthropic.messages.create({
      model: process.env.REVIEW_MODEL || "claude-sonnet-4-5",
      max_tokens: 2000,
      system:
        "You are a skeptical prediction-market risk reviewer. Your job is to catch bad algorithmic trade suggestions before money is placed on them. Be conservative: when the data is ambiguous, prefer downgrade over keep.",
      messages: [{ role: "user", content: userPrompt }],
    }),
  );

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[crypto/review] ${event.event_ticker}: input ${response.usage.input_tokens} tok, output ${response.usage.output_tokens} tok`,
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const review = parseReview(text);
  reviewCache.set(event.event_ticker, { review, suggestionsKey: key, ts: Date.now() });
  return review;
}

function pct(v: number | null): string {
  return v !== null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "N/A";
}
