import { describe, expect, it } from "vitest";
import { sameDayTailClampProb } from "@/lib/predictor";
import { KalshiMarket } from "@/types";

function makeMarket(overrides: Partial<KalshiMarket> & { ticker: string }): KalshiMarket {
  return {
    event_ticker: "EVT",
    yes_sub_title: overrides.ticker,
    no_sub_title: "",
    close_time: "2099-01-01T00:00:00Z",
    latest_expiration_time: "2099-01-01T00:00:00Z",
    status: "active",
    yes_bid_dollars: "0",
    yes_ask_dollars: "0",
    no_bid_dollars: "0",
    no_ask_dollars: "0",
    last_price_dollars: "0",
    volume_fp: "0",
    volume_24h_fp: "500",
    open_interest_fp: "0",
    notional_value_dollars: "0",
    result: "",
    rules_primary: "",
    rules_secondary: "",
    floor_strike: null,
    cap_strike: null,
    strike_type: "between",
    expiration_value: "",
    ...overrides,
  };
}

describe("sameDayTailClampProb", () => {
  it("clamps a same-day low strike well above the running low (Philly case)", () => {
    const m = makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84 });
    // Forecast/observed low 79 — "low ≥ 84" can no longer happen today
    expect(sameDayTailClampProb(0.08, m, "temperature_low", 79)).toBeLessThanOrEqual(0.02);
  });

  it("leaves strikes within the margin unclamped", () => {
    const m = makeMarket({ ticker: "T80", strike_type: "greater", floor_strike: 80 });
    // 80 < 79 + 3 margin — still plausible, keep the model's probability
    expect(sameDayTailClampProb(0.3, m, "temperature_low", 79)).toBe(0.3);
  });

  it("clamps between-buckets entirely above the running low", () => {
    const m = makeMarket({ ticker: "T85", strike_type: "between", floor_strike: 85, cap_strike: 87 });
    expect(sameDayTailClampProb(0.05, m, "temperature_low", 79)).toBeLessThanOrEqual(0.02);
  });

  it("clamps a same-day high strike well below the running high", () => {
    const m = makeMarket({ ticker: "T90", strike_type: "less", cap_strike: 90, floor_strike: null });
    // Running high already 95 — "high ≤ 90" can no longer happen
    expect(sameDayTailClampProb(0.07, m, "temperature_high", 95)).toBeLessThanOrEqual(0.02);
  });

  it("does not touch non-temperature metrics", () => {
    const m = makeMarket({ ticker: "RAIN", strike_type: "greater", floor_strike: 2 });
    expect(sameDayTailClampProb(0.4, m, "precipitation", 0.1)).toBe(0.4);
  });

  it("never raises a probability", () => {
    const m = makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84 });
    expect(sameDayTailClampProb(0.001, m, "temperature_low", 79)).toBe(0.001);
  });
});
