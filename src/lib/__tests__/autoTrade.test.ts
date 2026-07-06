import { describe, expect, it } from "vitest";
import { evaluateExit, sizeContracts } from "@/lib/autoTrade";
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
