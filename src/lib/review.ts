import Anthropic from "@anthropic-ai/sdk";
import { EnrichedEvent, WeatherForecast } from "@/types";
import { MODEL_LABELS } from "@/lib/weather";
import { getClient, callWithRetry } from "@/lib/analyze";
import { summarizeToday } from "@/lib/observed";
import { computeSuggestedActions, SuggestedAction } from "@/lib/suggest";

/**
 * On-demand AI review of the algorithmic trade suggestions for one event.
 *
 * Claude acts as a skeptic over the suggestion list: for each pick it returns
 * keep / downgrade / veto with a short reason. Runs only when the user clicks
 * the button, uses a cheap model, and caches per event — token-frugal.
 */

export type ReviewVerdict = "keep" | "downgrade" | "veto";

export interface SuggestionVerdict {
  ticker: string;
  side: "yes" | "no";
  verdict: ReviewVerdict;
  confidence: number; // 0-1
  reason: string;
}

export interface SuggestionReview {
  verdicts: SuggestionVerdict[];
  overall: string;
  generatedAt: string;
}

const REVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const reviewCache = new Map<
  string,
  { review: SuggestionReview; suggestionsKey: string; ts: number }
>();

/** Fingerprint of the suggestion set — a price move invalidates the cache. */
function suggestionsKey(suggestions: SuggestedAction[]): string {
  return suggestions.map((s) => `${s.ticker}:${s.side}:${s.price}`).join("|");
}

export async function reviewSuggestions(
  enriched: EnrichedEvent,
  forecast: WeatherForecast | null,
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
  if (
    cached &&
    cached.suggestionsKey === key &&
    Date.now() - cached.ts < REVIEW_CACHE_TTL_MS
  ) {
    return cached.review;
  }

  const anthropic = getClient();

  const predictionInfo = prediction
    ? `Verdict: ${prediction.verdict}
Forecast value: ${prediction.forecastValue ?? "N/A"} ${prediction.unit}
Target date: ${prediction.targetDate ?? "N/A"} (lead: ${prediction.leadDays ?? "?"} days)
Sigma (uncertainty stddev): ${prediction.sigma?.toFixed(2) ?? "N/A"}
Model agreement: ${prediction.agreement ?? "unknown"}
Detail: ${prediction.detail}`
    : "No model prediction available.";

  const targetDay =
    (prediction?.targetDate
      ? forecast?.daily.find((d) => d.date === prediction.targetDate)
      : undefined) ?? forecast?.daily[0];
  const byModelInfo =
    targetDay?.byModel && Object.keys(targetDay.byModel).length > 0
      ? Object.entries(targetDay.byModel)
          .map(
            ([model, v]) =>
              `  ${MODEL_LABELS[model] ?? model}: High ${v.max ?? "—"}°F / Low ${v.min ?? "—"}°F / Precip ${v.precip ?? "—"}"`,
          )
          .join("\n") +
        `\n  ENSEMBLE MEDIAN: High ${targetDay.max}°F / Low ${targetDay.min}°F`
      : "  Per-model breakdown not available.";

  const obs = forecast?.stationObs;
  const sameDay =
    prediction?.leadDays === 0 && forecast ? summarizeToday(forecast) : null;
  const obsInfo =
    obs && (obs.max !== null || obs.min !== null)
      ? `Station ${forecast?.stationId ?? "?"} (official settlement station): observed max so far ${obs.max ?? "—"}°F, min ${obs.min ?? "—"}°F (${obs.count} obs)` +
        (sameDay
          ? `\nRemaining hours of today (forecast, bias-corrected): max ${sameDay.remainingMax ?? "—"}°F, min ${sameDay.remainingMin ?? "—"}°F (${Math.round(
              sameDay.remainingFraction * 100,
            )}% of the day still ahead)`
          : "")
      : "No same-day station observations.";

  const semantics = `MARKET SEMANTICS (get the direction right):
- These markets settle on the FINAL midnight-to-midnight value at the settlement station.
- The running daily LOW can only stay the same or DROP as more hours pass — it never rises. So "low of X or above" is winning while the observed min is ≥ X, and loses only if temps fall below X before midnight. Conversely, once the observed min is BELOW X, "low of X or above" is permanently dead.
- The running daily HIGH can only stay the same or RISE. Once the observed max is above a cap, "high of cap or below" is permanently dead.
- Accumulated precipitation never decreases.
- PAYOFF: every contract pays $1.00 if the bought side wins, $0 otherwise. Buying a winner at a 1¢ ask returns ~100x the stake — a cheap ask on a likely winner is a LARGE edge, not a small one. Net EV per contract already subtracts the ask and the fee.`;

  const marketByTicker = new Map((event.markets ?? []).map((m) => [m.ticker, m]));
  const suggestionsText = suggestions
    .map((s, i) => {
      const m = marketByTicker.get(s.ticker);
      const strike = m?.strike_type
        ? ` [YES wins iff final value is ${m.strike_type}: floor=${m.floor_strike ?? "N/A"}, cap=${m.cap_strike ?? "N/A"}]`
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

  const userPrompt = `You are reviewing algorithmic trade suggestions for a Kalshi weather prediction market. Work ONLY from the data below — no web search or outside real-time information.

EVENT: ${event.title}
SUB-TITLE: ${event.sub_title}

APP PREDICTION MODEL SUMMARY:
${predictionInfo}

PER-MODEL FORECAST FOR TARGET DATE (${targetDay?.date ?? "unknown"}):
${byModelInfo}

SAME-DAY STATION OBSERVATIONS:
${obsInfo}

${semantics}

ALGORITHMIC SUGGESTIONS TO REVIEW:
${suggestionsText}

Act as a skeptical trading-desk reviewer. For EACH suggestion, judge whether the SUGGESTED SIDE will win at settlement:
- "keep": the numbers hold up — the suggested side is favored and the price offers real edge
- "downgrade": playable but weaker than the numbers imply (thin volume, high model disagreement, tail-heavy probability, or a too-good-to-be-true concern you cannot resolve from the data)
- "veto": the suggested side would likely LOSE — it is contradicted by the observations/physics, or its probability is an artifact of unreliable distribution tails

Important context:
- The station observations above come directly from the official NWS settlement station and are authoritative and current — do NOT assume they are stale.
- Kalshi weather markets are retail-heavy and often lag same-day observations. A large model-vs-market gap on a same-day, observation-backed market is a common and genuine edge — that is exactly what this tool hunts for. Do not veto a pick merely because the edge looks too large; veto only when the suggested side itself is the one the observations or physics contradict.
- Watch for: same-day markets where the running high/low already rules the SUGGESTED side out; longshot picks whose edge comes only from wide sigma; and suggestions contradicting the ensemble median without observation support.

For each suggestion, work through these steps IN ORDER and record them in the JSON:
1. "winCondition": what final settled value makes the SUGGESTED side (YES or NO as listed) win? Derive it from the strike spec. E.g. for BUY YES on [greater: floor=83] → "final low > 83"; for BUY NO on the same market → "final low <= 83".
2. "estFinalValue": your best estimate of the final settled value, from the observations and remaining-hours forecast.
3. "sideWins": does the estFinalValue satisfy the winCondition — "likely", "unlikely", or "uncertain"?
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
      // Directional reasoning (running low vs strike) trips up smaller models —
      // use Sonnet by default; it's behind a button and costs ~1-2¢ per click.
      model: process.env.REVIEW_MODEL || "claude-sonnet-4-5",
      max_tokens: 2000,
      system:
        "You are a skeptical prediction-market risk reviewer. Your job is to catch bad algorithmic trade suggestions before money is placed on them. Be conservative: when the data is ambiguous, prefer downgrade over keep.",
      messages: [{ role: "user", content: userPrompt }],
    }),
  );

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[review] ${event.event_ticker}: input ${response.usage.input_tokens} tok, output ${response.usage.output_tokens} tok`,
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

function parseReview(text: string): SuggestionReview {
  const generatedAt = new Date().toISOString();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { verdicts: [], overall: text.slice(0, 300), generatedAt };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const verdicts: SuggestionVerdict[] = Array.isArray(parsed.verdicts)
      ? parsed.verdicts
          .filter(
            (v: Record<string, unknown>) =>
              typeof v?.ticker === "string" &&
              (v?.side === "yes" || v?.side === "no") &&
              (v?.verdict === "keep" || v?.verdict === "downgrade" || v?.verdict === "veto"),
          )
          .map((v: Record<string, unknown>) => ({
            ticker: v.ticker as string,
            side: v.side as "yes" | "no",
            verdict: v.verdict as ReviewVerdict,
            confidence:
              typeof v.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : 0.5,
            reason: typeof v.reason === "string" ? v.reason : "",
          }))
      : [];
    return {
      verdicts,
      overall: typeof parsed.overall === "string" ? parsed.overall : "",
      generatedAt,
    };
  } catch {
    return { verdicts: [], overall: text.slice(0, 300), generatedAt };
  }
}
