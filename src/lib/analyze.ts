import Anthropic from "@anthropic-ai/sdk";
import { AiAnalysisResult, EnrichedEvent, WeatherForecast } from "@/types";
import { MODEL_LABELS } from "@/lib/weather";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your-anthropic-api-key-here") {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.",
      );
    }
    client = new Anthropic({
      apiKey,
      maxRetries: 5,
      timeout: 90_000, // 90s – Claude can take a while on complex prompts
    });
  }
  return client;
}

/**
 * Retriable network error signatures.
 * "Premature close", "fetch failed", ECONNRESET, etc. are transient and
 * worth retrying with back-off.
 */
const RETRIABLE_PATTERNS = [
  "premature close",
  "fetch failed",
  "econnreset",
  "etimedout",
  "socket hang up",
  "undisclosed",
  "aborted",
  "network error",
  "read econnreset",
];

function isRetriableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RETRIABLE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Wraps an async operation with exponential-backoff retries for transient
 * network failures (the most common cause of "Premature close").
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetriableError(err) || attempt === maxAttempts) throw err;
      // Exponential back-off: 1s → 2s → 4s (+ jitter)
      const delay = Math.pow(2, attempt - 1) * 1000 + Math.random() * 500;
      console.warn(
        `Anthropic API transient error (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function isAiConfigured(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!key && key !== "your-anthropic-api-key-here";
}

const SYSTEM_PROMPT = `You are an expert weather-prediction analyst specializing in Kalshi prediction market weather events. Your job is to analyze weather forecast data, market structure, and pricing to determine the most likely outcome of a weather prediction market.

Work ONLY from the data provided in the prompt. Do NOT use web search or rely on real-time information you cannot see here — everything needed (multi-model forecasts, official station observations, market prices, and computed probabilities) is included.

You should consider:
1. The multi-model ensemble forecast (ECMWF, GFS, NBM, HRRR) and its spread — disagreement means uncertainty
2. Official NWS settlement-station observations when present — these are authoritative for same-day markets (Kalshi settles on them)
3. The app's computed forecast-implied probabilities — they come from a normal-CDF model around the ensemble median with an empirically calibrated sigma; treat them as one input, not ground truth
4. Current market prices as crowd wisdom, and the edge (forecast minus market probability) as a value signal
5. Seasonal norms and climatological plausibility

Provide a clear, actionable recommendation with honest confidence levels.`;

/**
 * Run a deep AI analysis on a Kalshi weather event using Claude.
 *
 * Receives the full EnrichedEvent so the prompt can include the app's own
 * computed probabilities/edges alongside raw prices, plus per-model
 * forecasts and official station observations — everything needed so the
 * model never has to guess or search.
 */
export async function analyzeEvent(
  enriched: EnrichedEvent,
  forecast: WeatherForecast | null,
): Promise<AiAnalysisResult> {
  const anthropic = getClient();
  const { event, prediction } = enriched;

  const llMap = new Map(
    (prediction?.marketLikelihoods ?? []).map((ll) => [ll.ticker, ll]),
  );

  // All markets (capped at 25 by 24h volume to bound tokens), with both
  // sides' bid/ask and the app's computed numbers per market.
  const marketInfo = (event.markets || [])
    .sort((a, b) => parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0"))
    .slice(0, 25)
    .map((m, i) => {
      const strike = m.strike_type
        ? `[${m.strike_type}: floor=${m.floor_strike ?? "N/A"}, cap=${m.cap_strike ?? "N/A"}]`
        : "";
      const ll = llMap.get(m.ticker);
      const computed = ll
        ? ` | Forecast P(YES): ${Math.round(ll.probability * 100)}%${
            ll.marketProb != null ? ` | Market P(YES): ${Math.round(ll.marketProb * 100)}%` : ""
          }${ll.edge != null ? ` | Edge: ${ll.edge > 0 ? "+" : ""}${Math.round(ll.edge * 100)}pp` : ""}${
            ll.decided ? " | DECIDED by today's observations" : ""
          }`
        : "";
      return `  ${i + 1}. ${m.yes_sub_title || m.ticker} ${strike}
     YES bid/ask: ${m.yes_bid_dollars}/${m.yes_ask_dollars} | NO bid/ask: ${m.no_bid_dollars}/${m.no_ask_dollars} | Last: ${m.last_price_dollars} | 24h vol: ${m.volume_24h_fp}${computed}`;
    })
    .join("\n");

  // App prediction summary
  const predictionInfo = prediction
    ? `Verdict: ${prediction.verdict}
Forecast value: ${prediction.forecastValue ?? "N/A"} ${prediction.unit}
Target date: ${prediction.targetDate ?? "N/A"} (lead: ${prediction.leadDays ?? "?"} days)
Sigma (uncertainty stddev): ${prediction.sigma?.toFixed(2) ?? "N/A"}
Cross-model spread: ${prediction.modelSpread?.toFixed(2) ?? "N/A"} | Model agreement: ${prediction.agreement ?? "unknown"}
Detail: ${prediction.detail}`
    : "No model prediction available.";

  // Per-model forecast for the target date
  const targetDay =
    (prediction?.targetDate
      ? forecast?.daily.find((d) => d.date === prediction.targetDate)
      : undefined) ?? forecast?.daily[0];
  const byModelInfo =
    targetDay?.byModel && Object.keys(targetDay.byModel).length > 0
      ? Object.entries(targetDay.byModel)
          .map(
            ([model, v]) =>
              `  ${MODEL_LABELS[model] ?? model}: High ${v.max ?? "—"}°F / Low ${v.min ?? "—"}°F / Precip ${v.precip ?? "—"}" / Snow ${v.snow ?? "—"}"`,
          )
          .join("\n") +
        `\n  ENSEMBLE MEDIAN: High ${targetDay.max}°F / Low ${targetDay.min}°F` +
        (targetDay.spread
          ? `\n  Cross-model spread (σ): high ±${targetDay.spread.max.toFixed(1)}°F, low ±${targetDay.spread.min.toFixed(1)}°F, precip ±${targetDay.spread.precip.toFixed(2)}"`
          : "")
      : "  Per-model breakdown not available.";

  // Official settlement-station observations (same-day)
  const obs = forecast?.stationObs;
  const obsInfo =
    obs && (obs.max !== null || obs.min !== null)
      ? `Station ${forecast?.stationId ?? "?"} (official settlement station — AUTHORITATIVE for same-day markets):
  Observed max so far today: ${obs.max ?? "—"}°F | Observed min: ${obs.min ?? "—"}°F | ${obs.count} observations
  ${prediction?.observedSoFar !== undefined ? `Running metric value: ${prediction.observedSoFar}` : ""}${prediction?.alreadyDecided ? "\n  NOTE: today's observations have already locked this outcome." : ""}`
      : "No same-day station observations (event is not for today, or unavailable).";

  const forecastInfo = forecast
    ? forecast.daily
        .slice(0, 7)
        .map(
          (d) =>
            `  ${d.date}: High ${d.max}°F / Low ${d.min}°F / Rain ${d.rain ?? 0}" / Snow ${d.snowfall ?? 0}" / Rain Prob ${d.precipProb ?? 0}%`,
        )
        .join("\n")
    : "  No forecast data available.";

  const userPrompt = `Analyze this Kalshi weather prediction event and tell me the most likely outcome. All data you need is below — do not search for more.

EVENT: ${event.title}
SUB-TITLE: ${event.sub_title}
SERIES: ${event.series_ticker}
EVENT TICKER: ${event.event_ticker}

APP PREDICTION MODEL SUMMARY:
${predictionInfo}

MARKETS (up to 25 by volume, prices in dollars):
${marketInfo}

PER-MODEL FORECAST FOR TARGET DATE (${targetDay?.date ?? "unknown"}):
${byModelInfo}

SAME-DAY STATION OBSERVATIONS:
${obsInfo}

7-DAY CONSENSUS FORECAST:
${forecastInfo}

Based on the data above, provide:
1. The most likely YES/NO outcome or which specific market bucket is most likely
2. Your confidence level (High/Medium/Low)
3. Key reasoning for your conclusion
4. Factors to watch that could change the outcome

Format your response EXACTLY as this JSON (no markdown fences, no extra text before or after):
{
  "recommendedAnswer": "<your specific recommendation, e.g. 'YES - temperature will exceed 90°F' or 'The 85-89°F bucket'>",
  "confidence": "High|Medium|Low",
  "reasoning": "<2-4 sentences explaining your conclusion>",
  "factors": ["<factor 1>", "<factor 2>", "<factor 3>"]
}`;

  const response = await callWithRetry(() =>
    anthropic.messages.create({
      model: process.env.ANALYZE_MODEL || "claude-sonnet-4-5",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  );

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[analyze] ${event.event_ticker}: input ${response.usage.input_tokens} tok, output ${response.usage.output_tokens} tok`,
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Parse JSON from the response (Claude may occasionally wrap in markdown)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      recommendedAnswer: "Unable to parse analysis",
      confidence: "Low",
      reasoning: text.slice(0, 500),
      factors: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      recommendedAnswer: parsed.recommendedAnswer || "Unknown",
      confidence: parsed.confidence || "Medium",
      reasoning: parsed.reasoning || "",
      factors: Array.isArray(parsed.factors) ? parsed.factors : [],
    };
  } catch {
    return {
      recommendedAnswer: "Unable to parse analysis",
      confidence: "Low",
      reasoning: text.slice(0, 500),
      factors: [],
    };
  }
}
