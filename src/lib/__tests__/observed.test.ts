import { describe, expect, it } from "vitest";
import {
  observationForcedOutcome,
  sameDayMarketProbability,
  SameDayObservation,
} from "@/lib/observed";
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

function makeObs(overrides: Partial<SameDayObservation>): SameDayObservation {
  return {
    date: "2026-07-04",
    observedMax: null,
    observedMin: null,
    observedPrecip: 0,
    hoursObserved: 14,
    remainingFraction: 0.4,
    remainingMax: null,
    remainingMin: null,
    remainingPrecip: 0,
    source: "station",
    maxBias: 0,
    minBias: 0,
    ...overrides,
  };
}

describe("observationForcedOutcome", () => {
  it("locks NO for a low strike the day has already dipped below", () => {
    const obs = makeObs({ observedMin: 79 });
    const m = makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84 });
    expect(observationForcedOutcome(obs, m, "temperature_low")).toBe("no");
  });

  it("never locks YES for 'low stays above' strikes — temps can still drop", () => {
    const obs = makeObs({ observedMin: 84.2 });
    const m = makeMarket({ ticker: "T83", strike_type: "greater", floor_strike: 83 });
    expect(observationForcedOutcome(obs, m, "temperature_low")).toBeNull();
  });

  it("locks YES for 'low at or below cap' once the running low is under it", () => {
    const obs = makeObs({ observedMin: 79 });
    const m = makeMarket({ ticker: "L80", strike_type: "less", cap_strike: 80 });
    expect(observationForcedOutcome(obs, m, "temperature_low")).toBe("yes");
  });

  it("locks YES for a high strike the day has already exceeded", () => {
    const obs = makeObs({ observedMax: 95 });
    const m = makeMarket({ ticker: "G90", strike_type: "greater", floor_strike: 90 });
    expect(observationForcedOutcome(obs, m, "temperature_high")).toBe("yes");
  });

  it("never forces from model-assimilated (non-station) observations", () => {
    // Open-Meteo's assimilated past hours ran cold enough in live trading to
    // "force" outcomes that settled the other way (KXLOWTATL-26JUL09: model
    // obs forced NO, market settled YES at 76). Only official station obs may
    // force, no matter how wide the margin.
    const obs = makeObs({ observedMin: 79, source: "model" });
    const far = makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84 });
    expect(observationForcedOutcome(obs, far, "temperature_low")).toBeNull();
    const veryFar = makeMarket({ ticker: "T99", strike_type: "greater", floor_strike: 99 });
    expect(observationForcedOutcome(obs, veryFar, "temperature_low")).toBeNull();
  });

  it("station forcing demands a margin against rounded/provisional readings", () => {
    // 83.5 is within 1.0°F of the 84 floor — not locked.
    const obs = makeObs({ observedMin: 83.5 });
    const near = makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84 });
    expect(observationForcedOutcome(obs, near, "temperature_low")).toBeNull();
  });
});

describe("sameDayMarketProbability — decided semantics", () => {
  it("heatwave: high prob that the low stays ≥ strike is NOT decided (Philly case)", () => {
    // Running low 84.2 all day; tonight's forecast bias-shifted up by 5.2°F.
    const obs = makeObs({
      observedMin: 84.2,
      remainingMin: 84.2,
      minBias: 5.2,
      remainingFraction: 0.4,
    });
    const m = makeMarket({ ticker: "T83", strike_type: "greater", floor_strike: 83 });
    const res = sameDayMarketProbability(obs, m, "temperature_low", 1.9);
    expect(res).not.toBeNull();
    // Plausible but far from certain: the big applied bias widens sigma
    expect(res!.prob).toBeGreaterThan(0.3);
    expect(res!.prob).toBeLessThan(0.9);
    // Never "decided" — the low can still drop before midnight
    expect(res!.decided).toBe(false);
  });

  it("observed low below the strike locks the outcome as decided", () => {
    const obs = makeObs({ observedMin: 79, remainingMin: 80, remainingFraction: 0.4 });
    const m = makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84 });
    const res = sameDayMarketProbability(obs, m, "temperature_low", 1.9);
    expect(res).not.toBeNull();
    expect(res!.prob).toBeLessThanOrEqual(0.001);
    expect(res!.decided).toBe(true);
  });

  it("observed high above a greater-strike is decided YES", () => {
    const obs = makeObs({ observedMax: 95, remainingMax: 96, remainingFraction: 0.3 });
    const m = makeMarket({ ticker: "G90", strike_type: "greater", floor_strike: 90 });
    const res = sameDayMarketProbability(obs, m, "temperature_high", 1.9);
    expect(res).not.toBeNull();
    expect(res!.prob).toBeGreaterThanOrEqual(0.999);
    expect(res!.decided).toBe(true);
  });
});
