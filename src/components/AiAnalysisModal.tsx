"use client";

import { useState } from "react";
import { AiAnalysisResult } from "@/types";

interface AiAnalysisModalProps {
  eventTicker: string;
  eventTitle: string;
  isOpen: boolean;
  onClose: () => void;
  /** Analysis endpoint; the crypto dashboard points this at /api/crypto/analyze. */
  endpoint?: string;
}

export default function AiAnalysisModal({
  eventTicker,
  eventTitle,
  isOpen,
  onClose,
  endpoint = "/api/analyze",
}: AiAnalysisModalProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventTicker }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Analysis failed");
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to analysis service");
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-2xl bg-kalshi-surface border border-kalshi-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-kalshi-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-kalshi-text">Deep AI Analysis</h2>
              <p className="text-xs text-kalshi-muted truncate max-w-xs">{eventTitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-kalshi-muted hover:text-kalshi-text transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 max-h-[60vh] overflow-y-auto">
          {!result && !loading && !error && (
            <div className="text-center py-8">
              <p className="text-sm text-kalshi-muted mb-4">
                Run an AI-powered deep analysis using weather forecasts, market data, and
                climatology context powered by Claude.
              </p>
              <button
                onClick={runAnalysis}
                className="px-6 py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-sm font-semibold transition-all"
              >
                Run Analysis
              </button>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-10 h-10 border-3 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-kalshi-muted">Analyzing weather forecasts and market data...</p>
            </div>
          )}

          {error && (
            <div className="space-y-3">
              <div className="p-4 rounded-lg bg-kalshi-red/10 border border-kalshi-red/30">
                <p className="text-sm text-kalshi-red font-medium mb-1">Analysis Error</p>
                <p className="text-xs text-kalshi-muted">{error}</p>
              </div>
              <button
                onClick={runAnalysis}
                disabled={loading}
                className="w-full py-2 rounded-lg border border-kalshi-border hover:bg-white/5 text-sm text-kalshi-muted hover:text-kalshi-text transition-colors disabled:opacity-50"
              >
                Try Again
              </button>
            </div>
          )}

          {result && !loading && (
            <div className="space-y-4">
              {/* Recommendation */}
              <div className="p-4 rounded-xl bg-gradient-to-br from-purple-600/15 to-indigo-600/15 border border-purple-500/30">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-kalshi-muted mb-1">
                      AI Recommendation
                    </p>
                    <p className="text-base font-bold text-kalshi-text">
                      {result.recommendedAnswer}
                    </p>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-bold shrink-0 ${
                      result.confidence === "High"
                        ? "bg-kalshi-green/20 text-kalshi-green"
                        : result.confidence === "Medium"
                        ? "bg-yellow-500/20 text-yellow-500"
                        : "bg-kalshi-red/20 text-kalshi-red"
                    }`}
                  >
                    {result.confidence} Confidence
                  </span>
                </div>
              </div>

              {/* Reasoning */}
              {result.reasoning && (
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-kalshi-muted mb-1.5">
                    Reasoning
                  </p>
                  <p className="text-sm text-kalshi-text/90 leading-relaxed">{result.reasoning}</p>
                </div>
              )}

              {/* Factors */}
              {result.factors.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-kalshi-muted mb-1.5">
                    Factors to Watch
                  </p>
                  <ul className="space-y-1.5">
                    {result.factors.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-kalshi-text/80">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-kalshi-orange mt-1.5 shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Re-run */}
              <button
                onClick={runAnalysis}
                className="w-full py-2 rounded-lg border border-kalshi-border hover:bg-white/5 text-sm text-kalshi-muted hover:text-kalshi-text transition-colors"
              >
                Re-run Analysis
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
