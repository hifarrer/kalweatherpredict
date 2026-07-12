import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { syncMeta } from "@/db/schema";
import { TakeProfitMode } from "@/lib/autoSettings";

/**
 * Crypto automation settings — one JSON blob in sync_meta under
 * "crypto_automation_settings", fully separate from the weather bot's blob.
 * Weather-only knobs (targetDateMode, obsBackedOnly) are gone; crypto adds
 * the τ window, per-asset caps, spread/staleness/vol-spike guards, and a
 * spot-backed-only toggle. Numeric defaults come from the backtest
 * (docs/backtest-report.md).
 */

export interface CryptoAutomationSettings {
  /** Master switch — cron runs are no-ops while false. */
  enabled: boolean;
  /** Max total capital (cost + fees) deployed across open positions, cents. */
  budgetCents: number;
  /** Max cost (incl. fees) of a single buy, cents. */
  maxPerTradeCents: number;
  takeProfitMode: TakeProfitMode;
  takeProfitValue: number; // percent
  stopLossEnabled: boolean;
  stopLossPct: number; // percent below cost
  // Buy filters (same semantics as the weather bot)
  minScore: number;
  minEv: number; // dollars per contract
  minWinProb: number; // 0-1
  maxBuysPerRun: number;
  maxOpenPositions: number;
  minAiConfidence: number; // 0-1
  minPriceCents: number;
  maxProbGap: number; // 0-1
  maxDailyLossCents: number;
  // Crypto-specific guards
  /** Only buy markets settling within this many hours. */
  maxTauHours: number;
  /** Never buy within this many minutes of settlement (fill risk). */
  minTauMinutes: number;
  /** Max concurrent open positions per asset (BTC/ETH). */
  maxPerAsset: number;
  /** Skip buys when the side's bid-ask spread exceeds this many cents. */
  maxSpreadCents: number;
  /** Halt all buys when the freshest spot quote is older than this. */
  maxSpotAgeSec: number;
  /** Halt an asset's buys when 30m realized vol > this × 24h realized vol. */
  volSpikeMult: number;
  /** Only buy spot-backed picks (near-settlement, outcome nearly locked). */
  spotBackedOnly: boolean;
}

export const CRYPTO_SETTINGS_KEY = "crypto_automation_settings";

export const DEFAULT_CRYPTO_AUTOMATION_SETTINGS: CryptoAutomationSettings = {
  enabled: false,
  budgetCents: 5000,
  maxPerTradeCents: 1000,
  takeProfitMode: "profit_pct",
  takeProfitValue: 30,
  stopLossEnabled: true,
  stopLossPct: 50,
  minScore: 0.05,
  minEv: 0.05,
  minWinProb: 0.4,
  maxBuysPerRun: 3,
  maxOpenPositions: 10,
  minAiConfidence: 0.6,
  minPriceCents: 40,
  maxProbGap: 0.35,
  maxDailyLossCents: 150,
  maxTauHours: 6,
  minTauMinutes: 5,
  maxPerAsset: 2,
  maxSpreadCents: 10,
  maxSpotAgeSec: 60,
  volSpikeMult: 3,
  spotBackedOnly: false,
};

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(v, min, max, fallback));
}

/** Coerce an arbitrary stored/posted object into a valid settings object. */
export function sanitizeCryptoSettings(raw: unknown): CryptoAutomationSettings {
  const d = DEFAULT_CRYPTO_AUTOMATION_SETTINGS;
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
    budgetCents: clampInt(s.budgetCents, 100, 10_000_000, d.budgetCents),
    maxPerTradeCents: clampInt(s.maxPerTradeCents, 100, 1_000_000, d.maxPerTradeCents),
    takeProfitMode: s.takeProfitMode === "capture_pct" ? "capture_pct" : "profit_pct",
    takeProfitValue: clampNumber(s.takeProfitValue, 1, 500, d.takeProfitValue),
    stopLossEnabled:
      typeof s.stopLossEnabled === "boolean" ? s.stopLossEnabled : d.stopLossEnabled,
    stopLossPct: clampNumber(s.stopLossPct, 1, 99, d.stopLossPct),
    minScore: clampNumber(s.minScore, 0, 1, d.minScore),
    minEv: clampNumber(s.minEv, 0, 0.95, d.minEv),
    minWinProb: clampNumber(s.minWinProb, 0, 0.99, d.minWinProb),
    maxBuysPerRun: clampInt(s.maxBuysPerRun, 1, 20, d.maxBuysPerRun),
    maxOpenPositions: clampInt(s.maxOpenPositions, 1, 100, d.maxOpenPositions),
    minAiConfidence: clampNumber(s.minAiConfidence, 0, 1, d.minAiConfidence),
    minPriceCents: clampInt(s.minPriceCents, 1, 99, d.minPriceCents),
    maxProbGap: clampNumber(s.maxProbGap, 0.05, 1, d.maxProbGap),
    maxDailyLossCents: clampInt(s.maxDailyLossCents, 0, 1_000_000, d.maxDailyLossCents),
    maxTauHours: clampNumber(s.maxTauHours, 0.1, 168, d.maxTauHours),
    minTauMinutes: clampInt(s.minTauMinutes, 0, 240, d.minTauMinutes),
    maxPerAsset: clampInt(s.maxPerAsset, 1, 50, d.maxPerAsset),
    maxSpreadCents: clampInt(s.maxSpreadCents, 1, 99, d.maxSpreadCents),
    maxSpotAgeSec: clampInt(s.maxSpotAgeSec, 5, 3600, d.maxSpotAgeSec),
    volSpikeMult: clampNumber(s.volSpikeMult, 1, 100, d.volSpikeMult),
    spotBackedOnly:
      typeof s.spotBackedOnly === "boolean" ? s.spotBackedOnly : d.spotBackedOnly,
  };
}

export async function getCryptoAutomationSettings(): Promise<CryptoAutomationSettings> {
  const row = await db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, CRYPTO_SETTINGS_KEY))
    .limit(1);
  return sanitizeCryptoSettings(row[0]?.value);
}

export async function saveCryptoAutomationSettings(
  patch: Partial<CryptoAutomationSettings>,
): Promise<CryptoAutomationSettings> {
  const current = await getCryptoAutomationSettings();
  const next = sanitizeCryptoSettings({ ...current, ...patch });
  await db
    .insert(syncMeta)
    .values({ key: CRYPTO_SETTINGS_KEY, value: next })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: next, updatedAt: new Date() },
    });
  return next;
}
