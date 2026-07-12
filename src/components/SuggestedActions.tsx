"use client";

import { useMemo, useState } from "react";
import { EnrichedEvent, KalshiMarket } from "@/types";
import { computeSuggestedActions } from "@/lib/suggest";
import { formatStrike } from "@/lib/format";
import { BuySide } from "./MarketsTable";
import { TradeSuggestion } from "./TradeModal";

interface SuggestedActionsProps {
  enriched: EnrichedEvent;
  onBuy: (market: KalshiMarket, side: BuySide, suggestion?: TradeSuggestion) => void;
  /** AI review endpoint; the crypto dashboard points this at /api/crypto/review. */
  reviewEndpoint?: string;
}

interface ReviewVerdictRow {
  ticker: string;
  side: "yes" | "no";
  verdict: "keep" | "downgrade" | "veto";
  confidence: number;
  reason: string;
}

interface SuggestionReview {
  verdicts: ReviewVerdictRow[];
  overall: string;
  generatedAt: string;
}

const VERDICT_STYLES: Record<ReviewVerdictRow["verdict"], { label: string; cls: string }> = {
  keep: { label: "AI: keep", cls: "bg-kalshi-green/15 text-kalshi-green" },
  downgrade: { label: "AI: caution", cls: "bg-amber-500/15 text-amber-300" },
  veto: { label: "AI: avoid", cls: "bg-kalshi-red/15 text-kalshi-red" },
};

/**
 * Algorithmic trade suggestions for the maximized event view:
 * consensus buckets (closest to the forecast) and positive-EV plays,
 * ranked by fee-adjusted, risk-weighted expected value. An on-demand
 * "AI review" button has Claude critique each pick (cached server-side).
 */
export default function SuggestedActions({
  enriched,
  onBuy,
  reviewEndpoint = "/api/suggest/review",
}: SuggestedActionsProps) {
  const suggestions = useMemo(() => computeSuggestedActions(enriched), [enriched]);
  const marketByTicker = useMemo(
    () => new Map((enriched.event.markets ?? []).map((m) => [m.ticker, m])),
    [enriched],
  );

  const [review, setReview] = useState<SuggestionReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const verdictByKey = useMemo(() => {
    const map = new Map<string, ReviewVerdictRow>();
    for (const v of review?.verdicts ?? []) map.set(`${v.ticker}:${v.side}`, v);
    return map;
  }, [review]);

  const runReview = async () => {
    setReviewing(true);
    setReviewError(null);
    try {
      const res = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventTicker: enriched.event.event_ticker }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Review failed (${res.status})`);
      setReview(data);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Review failed");
    } finally {
      setReviewing(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-kalshi-muted">
          Suggested actions
        </h3>
        {suggestions.length > 0 && (
          <button
            onClick={runReview}
            disabled={reviewing}
            className="px-2.5 py-1 rounded-lg bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 text-purple-200 text-[10px] font-semibold transition-colors disabled:opacity-40"
            title="Have Claude critique each suggestion against the forecast and observations"
          >
            {reviewing ? "Reviewing…" : review ? "Re-run AI review" : "AI review"}
          </button>
        )}
      </div>
      {reviewError && <p className="text-[11px] text-kalshi-red mb-2">{reviewError}</p>}
      {review?.overall && (
        <p className="text-[11px] text-purple-200/90 leading-snug mb-2">{review.overall}</p>
      )}
      {suggestions.length === 0 ? (
        <div className="rounded-xl border border-kalshi-border bg-black/20 p-4">
          <p className="text-xs text-kalshi-muted">
            No high-confidence suggestions for this event — after fees and
            blending with market prices, no liquid market offers meaningful
            expected value at a realistic win probability.
          </p>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {suggestions.map((s) => {
            const market = marketByTicker.get(s.ticker);
            const sideColor = s.side === "yes" ? "text-kalshi-green" : "text-kalshi-red";
            const evPositive = s.evPerContract > 0;
            const verdict = verdictByKey.get(`${s.ticker}:${s.side}`);
            const verdictStyle = verdict ? VERDICT_STYLES[verdict.verdict] : null;
            return (
              <div
                key={`${s.ticker}:${s.side}`}
                className="rounded-xl border border-kalshi-border bg-black/20 p-3 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-white/5 ${sideColor}`}>
                    Buy {s.side}
                  </span>
                  <span className="text-xs font-bold text-kalshi-text">
                    {s.marketTitle}
                    {market && (
                      <span className="text-kalshi-muted font-normal">
                        {" "}{formatStrike(market, enriched.subcategory)}
                      </span>
                    )}
                  </span>
                  <span
                    className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      evPositive
                        ? "text-kalshi-green bg-kalshi-green/15"
                        : "text-kalshi-muted bg-white/5"
                    }`}
                    title="Expected value per contract at the current ask, after Kalshi fees"
                  >
                    EV {evPositive ? "+" : ""}
                    {Math.round(s.evPerContract * 100)}¢
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                      s.kind === "consensus"
                        ? "bg-blue-500/15 text-blue-300"
                        : "bg-purple-500/15 text-purple-300"
                    }`}
                  >
                    {s.kind}
                  </span>
                  {verdictStyle && (
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${verdictStyle.cls}`}
                      title={verdict?.reason || undefined}
                    >
                      {verdictStyle.label}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-kalshi-muted leading-snug">{s.rationale}</p>
                {verdict?.reason && verdict.verdict !== "keep" && (
                  <p className="text-[11px] text-amber-200/80 leading-snug">{verdict.reason}</p>
                )}
                <div className="flex items-center justify-between mt-auto">
                  <span className="text-[10px] text-kalshi-muted">
                    Ask {Math.round(s.price * 100)}¢ + {Math.round(s.feePerContract * 100)}¢ fee
                    {" · "}Model {Math.round((s.side === "yes" ? s.forecastProb : 1 - s.forecastProb) * 100)}%
                    {" · "}Blend {Math.round(s.winProb * 100)}%
                    {s.marketProb != null && ` · MK ${Math.round(s.marketProb * 100)}%`}
                  </span>
                  {market && (
                    <button
                      onClick={() =>
                        onBuy(market, s.side, {
                          side: s.side,
                          kind: s.kind,
                          price: s.price,
                          forecastProb: s.forecastProb,
                          blendedProb: s.blendedProb,
                          winProb: s.winProb,
                          marketProb: s.marketProb,
                          feePerContract: s.feePerContract,
                          evPerContract: s.evPerContract,
                          score: s.score,
                          volume24h: s.volume24h,
                          metric: enriched.prediction?.metric ?? null,
                          targetDate: enriched.prediction?.targetDate ?? null,
                          leadDays: enriched.prediction?.leadDays ?? null,
                          aiVerdict: verdict?.verdict ?? null,
                          aiConfidence: verdict?.confidence ?? null,
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold text-white transition-colors ${
                        s.side === "yes"
                          ? "bg-kalshi-green hover:bg-green-500"
                          : "bg-kalshi-red hover:bg-red-500"
                      }`}
                    >
                      Buy {s.side.toUpperCase()} {Math.round(s.price * 100)}¢
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
