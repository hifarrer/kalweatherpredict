import { describe, expect, it } from "vitest";
import { evaluateExit, maySuppressStopLoss, sizeContracts } from "@/lib/autoTrade";
import { trailingGuardTripped } from "@/lib/tradeCommon";
import { EXCLUDED_WEATHER_SERIES } from "@/lib/weatherSeries";
import {
  DEFAULT_AUTOMATION_SETTINGS,
  sanitizeSettings,
} from "@/lib/autoSettings";

const tpProfit = (value: number, stopLoss = false, stopLossPct = 50) => ({
  takeProfitMode: "profit_pct" as const,
  takeProfitValue: value,
  stopLossEnabled: stopLoss,
  stopLossPct,
});

const tpCapture = (value: number) => ({
  takeProfitMode: "capture_pct" as const,
  takeProfitValue: value,
  stopLossEnabled: false,
  stopLossPct: 50,
});

describe("evaluateExit", () => {
  it("triggers profit_pct take-profit at exactly the threshold", () => {
    // bought 40¢, +50% = 60¢
    expect(evaluateExit(40, 60, tpProfit(50))).toBe("take_profit");
    expect(evaluateExit(40, 59, tpProfit(50))).toBeNull();
  });

  it("matches the user's example: $10 max, sell at 50% gain", () => {
    // 10 contracts at 100¢ total → cost 10¢ each; +50% = 15¢
    expect(evaluateExit(10, 15, tpProfit(50))).toBe("take_profit");
    expect(evaluateExit(10, 14, tpProfit(50))).toBeNull();
  });

  it("triggers capture_pct at the share of max potential profit", () => {
    // bought 40¢ → max profit 60¢; 50% captured = bid 70¢
    expect(evaluateExit(40, 70, tpCapture(50))).toBe("take_profit");
    expect(evaluateExit(40, 69, tpCapture(50))).toBeNull();
  });

  it("capture_pct handles near-payout cost without dividing by zero", () => {
    expect(evaluateExit(100, 100, tpCapture(50))).toBeNull();
  });

  it("triggers stop-loss when the bid falls far enough below cost", () => {
    // bought 40¢, −50% = 20¢
    expect(evaluateExit(40, 20, tpProfit(500, true, 50))).toBe("stop_loss");
    expect(evaluateExit(40, 21, tpProfit(500, true, 50))).toBeNull();
  });

  it("ignores stop-loss when disabled", () => {
    expect(evaluateExit(40, 1, tpProfit(500, false))).toBeNull();
  });

  it("prefers take-profit over stop-loss and rejects degenerate inputs", () => {
    expect(evaluateExit(40, 60, tpProfit(50, true, 1))).toBe("take_profit");
    expect(evaluateExit(0, 60, tpProfit(50))).toBeNull();
    expect(evaluateExit(40, 0, tpProfit(50, true, 1))).toBeNull();
  });
});

describe("sizeContracts", () => {
  it("caps by the per-trade budget", () => {
    // $10 per trade at 45¢ + 2¢ fee = 47¢ → 21 contracts
    expect(sizeContracts(45, 2, 1000, 100_000, 100)).toBe(21);
  });

  it("caps by the remaining total budget", () => {
    expect(sizeContracts(45, 2, 1000, 100, 100)).toBe(2);
  });

  it("caps by the global contract limit", () => {
    expect(sizeContracts(1, 1, 100_000, 100_000, 100)).toBe(100);
  });

  it("returns 0 when even one contract is unaffordable", () => {
    expect(sizeContracts(90, 1, 50, 100_000, 100)).toBe(0);
    expect(sizeContracts(90, 1, 1000, 50, 100)).toBe(0);
  });
});

describe("sanitizeSettings", () => {
  it("returns defaults for missing/garbage input", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_AUTOMATION_SETTINGS);
    expect(sanitizeSettings("nonsense")).toEqual(DEFAULT_AUTOMATION_SETTINGS);
    expect(sanitizeSettings({ budgetCents: "lots" })).toEqual(
      DEFAULT_AUTOMATION_SETTINGS,
    );
  });

  it("clamps out-of-range numbers", () => {
    const s = sanitizeSettings({
      budgetCents: -5,
      maxPerTradeCents: 99_999_999,
      takeProfitValue: 0,
      stopLossPct: 250,
      minWinProb: 3,
      maxBuysPerRun: 999,
    });
    expect(s.budgetCents).toBe(100);
    expect(s.maxPerTradeCents).toBe(1_000_000);
    expect(s.takeProfitValue).toBe(1);
    expect(s.stopLossPct).toBe(99);
    expect(s.minWinProb).toBe(0.99);
    expect(s.maxBuysPerRun).toBe(20);
  });

  it("rejects unknown enum values", () => {
    const s = sanitizeSettings({ takeProfitMode: "yolo", targetDateMode: "someday" });
    expect(s.takeProfitMode).toBe("profit_pct");
    expect(s.targetDateMode).toBe("prefer_tomorrow");
  });

  it("preserves valid values", () => {
    const s = sanitizeSettings({
      enabled: true,
      budgetCents: 2500,
      takeProfitMode: "capture_pct",
      targetDateMode: "tomorrow_only",
      obsBackedOnly: true,
    });
    expect(s.enabled).toBe(true);
    expect(s.budgetCents).toBe(2500);
    expect(s.takeProfitMode).toBe("capture_pct");
    expect(s.targetDateMode).toBe("tomorrow_only");
    expect(s.obsBackedOnly).toBe(true);
  });
});

describe("maySuppressStopLoss", () => {
  it("never suppresses without a fresh model snapshot", () => {
    expect(maySuppressStopLoss(null, 60, 30)).toBe(false);
  });

  it("no longer suppresses at merely 50-74% model win", () => {
    // The old >=50% bar rode 12 losers to settlement
    expect(maySuppressStopLoss(0.5, 60, 30)).toBe(false);
    expect(maySuppressStopLoss(0.74, 60, 30)).toBe(false);
  });

  it("suppresses on a moderate drawdown when the model is confident", () => {
    // bid 40¢ on a 60¢ cost: 33% down, model 80% — hold through the dip
    expect(maySuppressStopLoss(0.8, 60, 40)).toBe(true);
  });

  it("trusts a collapsed market over even a certain model", () => {
    // bid 10¢ on a 60¢ cost — book says dead; cut regardless of model claims
    expect(maySuppressStopLoss(0.99, 60, 10)).toBe(false);
  });

  it("still suppresses a cheap-entry dip that is not a collapse", () => {
    // cost 20¢, bid 12¢: bid <= 15¢ but only 40% drawdown — stale-book zone
    expect(maySuppressStopLoss(0.9, 20, 12)).toBe(true);
  });
});

describe("sanitizeSettings — v2 risk fields", () => {
  it("defaults and clamps the new filters", () => {
    const d = sanitizeSettings(undefined);
    expect(d.minPriceCents).toBe(40);
    // Backtest-tuned defaults (docs/weather-backtest-report.md, 2026-07-16)
    expect(d.maxProbGap).toBe(0.2);
    expect(d.minEv).toBe(0.08);
    expect(d.stopLossEnabled).toBe(false);
    expect(d.takeProfitValue).toBe(50);
    expect(d.maxDailyLossCents).toBe(150);
    expect(d.excludeCities).toEqual(["LAS", "DAL", "MSY"]);

    const s = sanitizeSettings({ minPriceCents: 500, maxProbGap: 0, maxDailyLossCents: -5 });
    expect(s.minPriceCents).toBe(99);
    expect(s.maxProbGap).toBe(0.05);
    expect(s.maxDailyLossCents).toBe(0);
  });

  it("sanitizes excludeCities to unique uppercase codes", () => {
    const s = sanitizeSettings({
      excludeCities: [" las", "dal", "DAL", 7, "not-a-code", "MSY "],
    });
    expect(s.excludeCities).toEqual(["LAS", "DAL", "MSY"]);
  });
});

describe("sanitizeSettings — universe-alignment fields", () => {
  it("accepts today_or_tomorrow and still rejects garbage", () => {
    expect(sanitizeSettings({ targetDateMode: "today_or_tomorrow" }).targetDateMode).toBe(
      "today_or_tomorrow",
    );
    expect(sanitizeSettings({ targetDateMode: "lead01" }).targetDateMode).toBe(
      "prefer_tomorrow",
    );
  });

  it("clamps maxPriceCents and disables an inverted price band", () => {
    expect(sanitizeSettings(undefined).maxPriceCents).toBe(99);
    expect(sanitizeSettings({ maxPriceCents: 85 }).maxPriceCents).toBe(85);
    expect(sanitizeSettings({ maxPriceCents: 500 }).maxPriceCents).toBe(99);
    // Cap below the floor is a config error — fall back to "no cap"
    const inverted = sanitizeSettings({ minPriceCents: 60, maxPriceCents: 50 });
    expect(inverted.minPriceCents).toBe(60);
    expect(inverted.maxPriceCents).toBe(99);
  });

  it("filters metrics to known values and never returns an empty allowlist", () => {
    expect(sanitizeSettings(undefined).metrics).toEqual([
      "temperature_high",
      "temperature_low",
    ]);
    expect(
      sanitizeSettings({ metrics: ["temperature_high", "vibes", 7] }).metrics,
    ).toEqual(["temperature_high"]);
    expect(sanitizeSettings({ metrics: ["vibes"] }).metrics).toEqual([
      "temperature_high",
      "temperature_low",
    ]);
    expect(sanitizeSettings({ metrics: [] }).metrics).toEqual([
      "temperature_high",
      "temperature_low",
    ]);
  });

  it("clamps the trailing-guard fields", () => {
    const d = sanitizeSettings(undefined);
    expect(d.trailingGuardTrades).toBe(20);
    expect(d.trailingGuardLossCents).toBe(100);
    const s = sanitizeSettings({ trailingGuardTrades: 9999, trailingGuardLossCents: -1 });
    expect(s.trailingGuardTrades).toBe(200);
    expect(s.trailingGuardLossCents).toBe(0);
  });
});

describe("EXCLUDED_WEATHER_SERIES", () => {
  it("matches hourly-temp and TWC-settled series", () => {
    for (const ticker of [
      "KXTEMPLAH-26JUL24-B80.5",
      "KXTEMPNYCH-26JUL24-T90",
      "KXHOLIDAYTMAX-26JUL04-B95.5",
      "KXHOLIDAYTMIN-26DEC25-T30",
      "KXRAINNYC-26JUL-5",
      "KXRAINCHIM-26JUL-6",
      "KXRAINHOLIDAY-26JUL04-Y",
    ]) {
      expect(ticker).toMatch(EXCLUDED_WEATHER_SERIES);
    }
  });

  it("does not match the daily temperature series the bot trades", () => {
    for (const ticker of [
      "KXHIGHNY-26JUL18-B79.5",
      "KXHIGHCHI-26JUL24-B78.5",
      "KXHIGHTPHX-26JUL23-B112.5",
      "KXLOWTAUS-26JUL16-B72.5",
      "KXLOWTSFO-26JUL24-T59",
    ]) {
      expect(ticker).not.toMatch(EXCLUDED_WEATHER_SERIES);
    }
  });
});

describe("trailingGuardTripped", () => {
  const guard = (trades: number, loss: number) => ({
    trailingGuardTrades: trades,
    trailingGuardLossCents: loss,
  });

  it("trips only when a full window sums to the loss threshold or worse", () => {
    expect(trailingGuardTripped(20, -100, guard(20, 100))).toBe(true);
    expect(trailingGuardTripped(20, -250, guard(20, 100))).toBe(true);
    expect(trailingGuardTripped(20, -99, guard(20, 100))).toBe(false);
    expect(trailingGuardTripped(20, 50, guard(20, 100))).toBe(false);
  });

  it("never trips on a partial window or when disabled", () => {
    // Two early losers on a fresh book must not halt the bot
    expect(trailingGuardTripped(2, -500, guard(20, 100))).toBe(false);
    expect(trailingGuardTripped(20, -500, guard(0, 100))).toBe(false);
  });
});
