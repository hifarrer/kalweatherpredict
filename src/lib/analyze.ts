import Anthropic from "@anthropic-ai/sdk";
import { AiAnalysisResult, KalshiEvent, WeatherForecast } from "@/types";

let client: Anthropic | null = null;

function getClient(): Anthropic {
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
async function callWithRetry<T>(
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

const SYSTEM_PROMPT = `You are an expert weather-prediction analyst specializing in Kalshi prediction market weather events. Your job is to analyze weather forecast data, market structure, and any relevant climatology context to determine the most likely outcome of a weather prediction market.

You should consider:
1. Official weather forecasts (NOAA, NWS, ECMWF data provided to you)
2. Historical climate patterns and seasonal norms
3. Forecast uncertainty and model spread
4. Current market prices as a signal of crowd wisdom
5. Any relevant news or extreme weather events

Provide a clear, actionable recommendation with honest confidence levels.`;

/**
 * Run a deep AI analysis on a Kalshi weather event using Claude.
 */
export async function analyzeEvent(
  event: KalshiEvent,
  forecast: WeatherForecast | null,
): Promise<AiAnalysisResult> {
  const anthropic = getClient();

  const marketInfo = (event.markets || [])
    .sort((a, b) => parseFloat(b.volume_24h_fp || "0") - parseFloat(a.volume_24h_fp || "0"))
    .slice(0, 10)
    .map((m, i) => {
      const strike = m.strike_type
        ? `[${m.strike_type}: floor=${m.floor_strike ?? "N/A"}, cap=${m.cap_strike ?? "N/A"}]`
        : "";
      return `  ${i + 1}. ${m.yes_sub_title || m.ticker}
     Strike: ${strike}
     YES bid: ${m.yes_bid_dollars} | Last price: ${m.last_price_dollars}
     24h volume: ${m.volume_24h_fp} | Total volume: ${m.volume_fp}
     Rules: ${m.rules_primary}`;
    })
    .join("\n");

  const forecastInfo = forecast
    ? forecast.daily
        .slice(0, 7)
        .map(
          (d) =>
            `  ${d.date}: High ${d.max}°F / Low ${d.min}°F / Rain ${d.rain ?? 0}" / Snow ${d.snowfall ?? 0}" / Rain Prob ${d.precipProb ?? 0}%`,
        )
        .join("\n")
    : "  No forecast data available.";

  const userPrompt = `Analyze this Kalshi weather prediction event and tell me the most likely outcome.

EVENT: ${event.title}
SUB-TITLE: ${event.sub_title}
SERIES: ${event.series_ticker}
EVENT TICKER: ${event.event_ticker}

MARKETS (top 10 by volume):
${marketInfo}

WEATHER FORECAST (next 7 days):
${forecastInfo}

Based on the forecast data, market structure, and your knowledge of weather patterns, provide:
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
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  );

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
