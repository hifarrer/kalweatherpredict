import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { syncMeta } from "@/db/schema";

/**
 * Automation settings — stored as one JSON blob in sync_meta under
 * "automation_settings" (same pattern as weather_series), typed and
 * defaulted here so new knobs can be added without a migration.
 */

export type TakeProfitMode = "profit_pct" | "capture_pct";
export type TargetDateMode = "tomorrow_only" | "prefer_tomorrow" | "any";

export interface AutomationSettings {
  /** Master switch — cron runs are no-ops while false. */
  enabled: boolean;
  /** Max total capital (cost + fees) deployed across open positions, cents. */
  budgetCents: number;
  /** Max cost (incl. fees) of a single buy, cents. */
  maxPerTradeCents: number;
  /**
   * Take-profit trigger. profit_pct: sell when gain over cost ≥ value%.
   * capture_pct: sell when (bid − cost) / (100 − cost) ≥ value%.
   */
  takeProfitMode: TakeProfitMode;
  takeProfitValue: number; // percent
  stopLossEnabled: boolean;
  stopLossPct: number; // percent below cost
  // Buy filters
  minScore: number;
  minEv: number; // dollars per contract
  minWinProb: number; // 0-1
  obsBackedOnly: boolean;
  targetDateMode: TargetDateMode;
  maxBuysPerRun: number;
  maxOpenPositions: number;
  /** AI review gate: only "keep" verdicts at or above this confidence buy. */
  minAiConfidence: number; // 0-1
  /**
   * Skip buys with an ask below this. Cheap contracts are where the model
   * disagrees hardest with the market — live record 6 wins / 35 trades,
   * −$5.27 under 40¢ vs +$0.75 at 40¢+.
   */
  minPriceCents: number;
  /**
   * Skip buys where blended winProb exceeds market-implied prob by more than
   * this. When model and market disagree wildly, the market has been right.
   */
  maxProbGap: number; // 0-1
  /**
   * Circuit breaker: halt the buy pass (sells keep running) once realized
   * losses over the trailing 24h reach this many cents. 0 disables it.
   */
  maxDailyLossCents: number;
  /**
   * City codes the bot never buys. Seeded with the cities that were
   * persistently negative across ~1k graded picks each (LAS 15.9% win,
   * −9.2¢/contract realized EV; DAL, MSY similar) — every top backtest
   * configuration excluded them.
   */
  excludeCities: string[];
}

export const AUTOMATION_SETTINGS_KEY = "automation_settings";

// Defaults tuned by the weather backtest (docs/weather-backtest-report.md,
// 2026-07-16): w=0.2/wObs=0.5 blend (SECTION_SCORING), minEv 8¢, price ≥ 40¢,
// prob gap ≤ 0.2, TP 50% with stop-loss OFF (stop-losses realized −$22.42 live
// vs −$2.42 held; no stop-loss config made the backtest top-40), LAS/DAL/MSY
// excluded. Validation split: 108 trades, 73% win, +$93.05 (8.9% ROI).
export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: false,
  budgetCents: 5000,
  maxPerTradeCents: 1000,
  takeProfitMode: "profit_pct",
  takeProfitValue: 50,
  stopLossEnabled: false,
  stopLossPct: 50,
  minScore: 0.05,
  minEv: 0.08,
  minWinProb: 0.4,
  obsBackedOnly: false,
  targetDateMode: "prefer_tomorrow",
  maxBuysPerRun: 3,
  maxOpenPositions: 10,
  minAiConfidence: 0.6,
  minPriceCents: 40,
  maxProbGap: 0.2,
  maxDailyLossCents: 150,
  excludeCities: ["LAS", "DAL", "MSY"],
};

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(v, min, max, fallback));
}

/** Coerce an arbitrary stored/posted object into a valid settings object. */
export function sanitizeSettings(raw: unknown): AutomationSettings {
  const d = DEFAULT_AUTOMATION_SETTINGS;
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
    budgetCents: clampInt(s.budgetCents, 100, 10_000_000, d.budgetCents),
    maxPerTradeCents: clampInt(s.maxPerTradeCents, 100, 1_000_000, d.maxPerTradeCents),
    takeProfitMode:
      s.takeProfitMode === "capture_pct" ? "capture_pct" : "profit_pct",
    takeProfitValue: clampNumber(s.takeProfitValue, 1, 500, d.takeProfitValue),
    stopLossEnabled:
      typeof s.stopLossEnabled === "boolean" ? s.stopLossEnabled : d.stopLossEnabled,
    stopLossPct: clampNumber(s.stopLossPct, 1, 99, d.stopLossPct),
    minScore: clampNumber(s.minScore, 0, 1, d.minScore),
    minEv: clampNumber(s.minEv, 0, 0.95, d.minEv),
    minWinProb: clampNumber(s.minWinProb, 0, 0.99, d.minWinProb),
    obsBackedOnly:
      typeof s.obsBackedOnly === "boolean" ? s.obsBackedOnly : d.obsBackedOnly,
    targetDateMode:
      s.targetDateMode === "tomorrow_only" || s.targetDateMode === "any"
        ? s.targetDateMode
        : "prefer_tomorrow",
    maxBuysPerRun: clampInt(s.maxBuysPerRun, 1, 20, d.maxBuysPerRun),
    maxOpenPositions: clampInt(s.maxOpenPositions, 1, 100, d.maxOpenPositions),
    minAiConfidence: clampNumber(s.minAiConfidence, 0, 1, d.minAiConfidence),
    minPriceCents: clampInt(s.minPriceCents, 1, 99, d.minPriceCents),
    maxProbGap: clampNumber(s.maxProbGap, 0.05, 1, d.maxProbGap),
    maxDailyLossCents: clampInt(s.maxDailyLossCents, 0, 1_000_000, d.maxDailyLossCents),
    excludeCities: Array.isArray(s.excludeCities)
      ? [...new Set(
          s.excludeCities
            .filter((c): c is string => typeof c === "string")
            .map((c) => c.trim().toUpperCase())
            .filter((c) => /^[A-Z]{2,4}$/.test(c)),
        )].slice(0, 30)
      : d.excludeCities,
  };
}

export async function getAutomationSettings(): Promise<AutomationSettings> {
  const row = await db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, AUTOMATION_SETTINGS_KEY))
    .limit(1);
  return sanitizeSettings(row[0]?.value);
}

export async function saveAutomationSettings(
  patch: Partial<AutomationSettings>,
): Promise<AutomationSettings> {
  const current = await getAutomationSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await db
    .insert(syncMeta)
    .values({ key: AUTOMATION_SETTINGS_KEY, value: next })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: next, updatedAt: new Date() },
    });
  return next;
}
