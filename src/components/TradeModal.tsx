"use client";

import { useEffect, useState } from "react";
import { KalshiMarket } from "@/types";
import { BuySide } from "./MarketsTable";

/**
 * Snapshot of the AI suggestion a buy was initiated from, forwarded to
 * /api/orders so the order can later be graded against what the AI claimed.
 */
export interface TradeSuggestion {
  side: BuySide;
  kind: "consensus" | "value";
  price: number;
  forecastProb: number;
  blendedProb: number;
  winProb: number;
  marketProb: number | null;
  feePerContract: number;
  evPerContract: number;
  score: number;
  volume24h: number;
  metric: string | null;
  targetDate: string | null;
  leadDays: number | null;
  aiVerdict: string | null;
  aiConfidence: number | null;
}

interface TradeModalProps {
  market: KalshiMarket;
  side: BuySide;
  eventTicker: string;
  eventTitle: string;
  isOpen: boolean;
  onClose: () => void;
  /** Present when the buy was initiated from a suggestion card. */
  suggestion?: TradeSuggestion | null;
}

type Step = "form" | "confirm" | "result";

interface OrderResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  fillCount?: number;
  fillCostCents?: number;
  avgFillPriceCents?: number | null;
  error?: string;
}

const MAX_COST_BUFFER_CENTS = 5; // keep in sync with /api/orders

/**
 * Kalshi-style buy flow: quantity form → confirmation → result.
 * Market orders with a max-cost cap (ask + buffer per contract).
 */
export default function TradeModal({
  market,
  side,
  eventTicker,
  eventTitle,
  isOpen,
  onClose,
  suggestion,
}: TradeModalProps) {
  const [step, setStep] = useState<Step>("form");
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OrderResult | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  const askDollars = parseFloat(
    (side === "yes" ? market.yes_ask_dollars : market.no_ask_dollars) || "0",
  );
  const askCents = Math.round(askDollars * 100);

  // Reset when reopened for a different market/side
  useEffect(() => {
    if (isOpen) {
      setStep("form");
      setCount(1);
      setResult(null);
      fetch("/api/portfolio/balance", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          setConfigured(d.configured === true);
          setBalance(typeof d.balanceCents === "number" ? d.balanceCents : null);
        })
        .catch(() => setConfigured(null));
    }
  }, [isOpen, market.ticker, side]);

  if (!isOpen) return null;

  const estCostCents = count * askCents;
  const maxCostCents = count * (askCents + MAX_COST_BUFFER_CENTS);
  const maxPayoutCents = count * 100;

  const placeOrder = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: market.ticker,
          eventTicker,
          side,
          count,
          askCents,
          ...(suggestion ? { suggestion } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, error: data.error || `Order failed (${res.status})` });
      } else {
        setResult({ ok: true, ...data });
      }
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "Could not reach the server",
      });
    } finally {
      setSubmitting(false);
      setStep("result");
    }
  };

  const sideColor = side === "yes" ? "text-kalshi-green" : "text-kalshi-red";
  const sideBg =
    side === "yes"
      ? "bg-kalshi-green hover:bg-green-500"
      : "bg-kalshi-red hover:bg-red-500";
  const invalidAsk = askCents < 1 || askCents > 99;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md bg-kalshi-surface border border-kalshi-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-kalshi-border">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-kalshi-text">
              Buy <span className={sideColor}>{side.toUpperCase()}</span>
              {" · "}
              {market.yes_sub_title || market.ticker}
            </h2>
            <p className="text-[11px] text-kalshi-muted truncate">{eventTitle}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-kalshi-muted hover:text-kalshi-text hover:bg-white/5 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* LIVE badge + balance */}
          <div className="flex items-center justify-between text-[11px]">
            <span className="px-2 py-0.5 rounded-full font-bold bg-kalshi-red/15 text-kalshi-red border border-kalshi-red/30">
              LIVE — REAL MONEY
            </span>
            <span className="text-kalshi-muted">
              {balance !== null
                ? `Balance: $${(balance / 100).toFixed(2)}`
                : configured === false
                  ? "Trading not configured"
                  : ""}
            </span>
          </div>

          {configured === false && (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
              Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_BASE64 to .env to enable trading.
            </div>
          )}

          {invalidAsk && (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
              No ask price available for this side — the order book may be empty.
            </div>
          )}

          {step === "form" && (
            <>
              <div className="space-y-1">
                <label htmlFor="contracts" className="text-xs text-kalshi-muted font-medium">
                  Contracts
                </label>
                <input
                  id="contracts"
                  type="number"
                  min={1}
                  max={1000}
                  value={count}
                  onChange={(e) =>
                    setCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))
                  }
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-kalshi-border text-sm text-kalshi-text focus:outline-none focus:border-kalshi-orange transition-colors"
                />
              </div>

              <div className="rounded-lg bg-black/20 border border-kalshi-border p-3 space-y-1.5 text-xs">
                <Row label="Price (ask)" value={`${askCents}¢ / contract`} />
                <Row label="Estimated cost" value={`$${(estCostCents / 100).toFixed(2)}`} />
                <Row
                  label={`Max cost (ask + ${MAX_COST_BUFFER_CENTS}¢ buffer)`}
                  value={`$${(maxCostCents / 100).toFixed(2)}`}
                />
                <Row label="Max payout" value={`$${(maxPayoutCents / 100).toFixed(2)}`} bold />
                <Row
                  label="Potential profit"
                  value={`$${((maxPayoutCents - estCostCents) / 100).toFixed(2)}`}
                  bold
                />
              </div>

              <button
                onClick={() => setStep("confirm")}
                disabled={configured !== true || invalidAsk}
                className={`w-full px-4 py-2.5 rounded-lg text-white text-sm font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${sideBg}`}
              >
                Review order
              </button>
            </>
          )}

          {step === "confirm" && (
            <>
              <div className="rounded-lg bg-black/20 border border-kalshi-border p-4 text-center space-y-1">
                <p className="text-sm text-kalshi-text font-bold">
                  Buy {count} {side.toUpperCase()} @ ~{askCents}¢
                </p>
                <p className="text-xs text-kalshi-muted">
                  Est. cost ${(estCostCents / 100).toFixed(2)} · max $
                  {(maxCostCents / 100).toFixed(2)} · payout $
                  {(maxPayoutCents / 100).toFixed(2)} if {side.toUpperCase()} wins
                </p>
                <p className="text-[11px] text-kalshi-red font-semibold">
                  Market order with real money — fills immediately.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setStep("form")}
                  disabled={submitting}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-kalshi-border text-kalshi-muted hover:text-kalshi-text hover:bg-white/5 text-sm font-medium transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={placeOrder}
                  disabled={submitting}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-white text-sm font-bold transition-colors disabled:opacity-60 ${sideBg}`}
                >
                  {submitting ? "Placing order..." : "Confirm buy"}
                </button>
              </div>
            </>
          )}

          {step === "result" && result && (
            <>
              {result.ok ? (
                <div className="rounded-lg bg-kalshi-green/10 border border-kalshi-green/30 p-4 text-center space-y-1">
                  <svg
                    className="w-8 h-8 mx-auto text-kalshi-green"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm font-bold text-kalshi-green">Order placed</p>
                  <p className="text-xs text-kalshi-text">
                    {result.fillCount ?? 0} of {count} filled
                    {result.avgFillPriceCents != null && ` @ avg ${result.avgFillPriceCents}¢`}
                    {result.fillCostCents != null &&
                      ` — total $${(result.fillCostCents / 100).toFixed(2)}`}
                  </p>
                  <p className="text-[10px] text-kalshi-muted">
                    Status: {result.status} · Order {result.orderId}
                  </p>
                </div>
              ) : (
                <div className="rounded-lg bg-kalshi-red/10 border border-kalshi-red/30 p-4 text-center space-y-1">
                  <p className="text-sm font-bold text-kalshi-red">Order failed</p>
                  <p className="text-xs text-kalshi-text">{result.error}</p>
                </div>
              )}
              <div className="flex gap-2">
                {!result.ok && (
                  <button
                    onClick={() => setStep("form")}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-kalshi-border text-kalshi-muted hover:text-kalshi-text hover:bg-white/5 text-sm font-medium transition-colors"
                  >
                    Try again
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-kalshi-text text-sm font-semibold transition-colors"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-kalshi-muted">{label}</span>
      <span className={bold ? "text-kalshi-text font-bold" : "text-kalshi-text"}>{value}</span>
    </div>
  );
}
