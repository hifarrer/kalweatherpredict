import Anthropic from "@anthropic-ai/sdk";
import { AiAnalysisResult, EnrichedEvent } from "@/types";
import { getClient, callWithRetry } from "@/lib/analyze";
import { CryptoAssetContext } from "@/lib/crypto/cryptoEnrich";

/**
 * On-demand deep AI analysis of one crypto event — the crypto counterpart
 * of analyzeEvent() in analyze.ts, returning the same AiAnalysisResult shape
 * so AiAnalysisModal renders it unchanged.
 */

const MAX_MARKETS_IN_PROMPT = 25;

export async function analyzeCryptoEvent(
  enriched: EnrichedEvent,
  ctx: CryptoAssetContext | null,
): Promise<AiAnalysisResult> {
  const { event, prediction } = enriched;
  const anthropic = getClient();

  const spotAgeSec = ctx ? Math.round((Date.now() - ctx.spot.ts) / 1000) : null;
  const marketDataInfo = ctx
    ? `Live spot: $${ctx.spot.price.toLocaleString("en-US")} via ${ctx.spot.source} (${spotAgeSec}s old — current)
Realized vol (annualized): 30m ${pct(ctx.rvs.rv30m)}, 2h ${pct(ctx.rvs.rv2h)}, 8h ${pct(ctx.rvs.rv8h)}, 24h ${pct(ctx.rvs.rv24h)}
Implied vol (Deribit DVOL): ${pct(ctx.dvol)}`
    : "No live market data available.";

  const predictionInfo = prediction
    ? `${prediction.detail}
Time to settlement: ${prediction.tauHours !== undefined ? `${Math.round(prediction.tauHours * 60)} minutes` : "?"}
Log-space σ√τ: ${prediction.sigma !== undefined ? (prediction.sigma * 100).toFixed(2) + "%" : "N/A"}
Expected move by settlement: ~$${
        prediction.sigma !== undefined && prediction.forecastValue
          ? Math.round(prediction.forecastValue * prediction.sigma).toLocaleString("en-US")
          : "?"
      } (1σ)`
    : "No model prediction available.";

  const probByTicker = new Map(
    (prediction?.marketLikelihoods ?? []).map((l) => [l.ticker, l]),
  );
  const marketsText = (event.markets ?? [])
    .filter((m) => parseFloat(m.volume_24h_fp || "0") > 0)
    .slice(0, MAX_MARKETS_IN_PROMPT)
    .map((m) => {
      const ll = probByTicker.get(m.ticker);
      return `  "${m.yes_sub_title}" [${m.strike_type}: floor=${m.floor_strike ?? "N/A"}, cap=${m.cap_strike ?? "N/A"}] bid ${m.yes_bid_dollars} / ask ${m.yes_ask_dollars} | model P(YES) ${
        ll ? `${Math.round(ll.probability * 100)}%` : "?"
      } | edge ${ll?.edge !== undefined ? `${ll.edge >= 0 ? "+" : ""}${Math.round(ll.edge * 100)}%` : "?"} | 24h vol ${m.volume_24h_fp}`;
    })
    .join("\n");

  const userPrompt = `Analyze this Kalshi crypto price market event. Work ONLY from the data below — no web search or outside real-time information.

EVENT: ${event.title}
SUB-TITLE: ${event.sub_title}
SETTLEMENT: the CF Benchmarks reference rate for the asset at the stated time (the live spot below is a close proxy). The price can move either way until the last second — this is a point-in-time settlement, not a running max/min.

LIVE MARKET DATA:
${marketDataInfo}

APP MODEL (drift-free log-normal diffusion around spot):
${predictionInfo}

MARKETS (model probability vs current book):
${marketsText}

Give your assessment:
1. Which single market (strike bracket) is most likely to settle YES, and why.
2. Whether the app model's probabilities look trustworthy right now — pay attention to the vol regime (30m realized vs 24h realized vs implied: a 30m spike means the expected move may be underestimated) and to strikes within one expected move of spot.
3. The best value opportunity on the board, if any (largest justified model-vs-market gap), or say there is none.

Format your response EXACTLY as this JSON (no markdown fences, no extra text):
{
  "recommendedAnswer": "<the yes_sub_title of the bracket most likely to settle YES>",
  "confidence": "High|Medium|Low",
  "reasoning": "<2-4 sentences>",
  "factors": ["<short factor 1>", "<short factor 2>", "<short factor 3>"]
}`;

  const response = await callWithRetry(() =>
    anthropic.messages.create({
      model: process.env.ANALYZE_MODEL || "claude-sonnet-4-5",
      max_tokens: 1500,
      system:
        "You are an expert crypto market analyst for prediction markets. You reason from live spot, realized/implied volatility, and time to settlement. You are precise about what one expected move (spot × σ√τ) covers.",
      messages: [{ role: "user", content: userPrompt }],
    }),
  );

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseAnalysis(text);
}

function parseAnalysis(text: string): AiAnalysisResult {
  const fallback: AiAnalysisResult = {
    recommendedAnswer: "Unknown",
    confidence: "Low",
    reasoning: text.slice(0, 400),
    factors: [],
  };
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      recommendedAnswer:
        typeof parsed.recommendedAnswer === "string" ? parsed.recommendedAnswer : "Unknown",
      confidence: ["High", "Medium", "Low"].includes(parsed.confidence)
        ? parsed.confidence
        : "Low",
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      factors: Array.isArray(parsed.factors)
        ? parsed.factors.filter((f: unknown) => typeof f === "string").slice(0, 6)
        : [],
    };
  } catch {
    return fallback;
  }
}

function pct(v: number | null): string {
  return v !== null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "N/A";
}
