import { describe, expect, it } from "vitest";
import {
  detectMetric,
  getTargetDay,
  sameDayTailClampProb,
  STALE_EVENT_INDEX,
} from "@/lib/predictor";
import { KalshiEvent, KalshiMarket, WeatherForecast } from "@/types";

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

describe("getTargetDay — midnight rollover", () => {
  function makeForecast(dates: string[]): WeatherForecast {
    return {
      city: "Houston",
      todayHigh: null,
      todayLow: null,
      daily: dates.map((date) => ({ date, max: 95, min: 78 })),
      hourlyTimes: [],
      hourlyTemps: [],
    };
  }

  function makeDatedEvent(title: string, strikeDate: string | null): KalshiEvent {
    return {
      event_ticker: "KXHIGHTHOU-26JUL13",
      series_ticker: "KXHIGHTHOU",
      title,
      sub_title: "",
      category: "Climate and Weather",
      strike_date: strikeDate,
      markets: [],
    };
  }

  // It's just past local midnight: daily[0] has rolled to Jul 14 (CDT), but
  // yesterday's event is still open until its 12:59 AM close.
  const forecast = makeForecast(["2026-07-14", "2026-07-15", "2026-07-16"]);
  const tz = "America/Chicago";

  it("refuses to predict yesterday's still-open event after local midnight", () => {
    const event = makeDatedEvent(
      "Highest temperature in Houston on Jul 13, 2026?",
      "2026-07-13T12:00:00Z",
    );
    // close_time 05:59Z = 12:59 AM CDT Jul 14 — the exact candidate that used
    // to rescue the stale event and score it against the NEW day's forecast
    // and 1 AM observations (99.7% of target-date-mismatched picks lost).
    const market = makeMarket({ ticker: "T86", close_time: "2026-07-14T05:59:00Z" });
    const target = getTargetDay(forecast, event, market, tz);
    expect(target.index).toBe(STALE_EVENT_INDEX);
    expect(target.date).toBeNull();
  });

  it("resolves today's event to index 0", () => {
    const event = makeDatedEvent(
      "Highest temperature in Houston on Jul 14, 2026?",
      "2026-07-14T12:00:00Z",
    );
    const market = makeMarket({ ticker: "T86", close_time: "2026-07-15T05:59:00Z" });
    expect(getTargetDay(forecast, event, market, tz).index).toBe(0);
  });

  it("resolves tomorrow's event to index 1", () => {
    const event = makeDatedEvent(
      "Highest temperature in Houston on Jul 15, 2026?",
      "2026-07-15T12:00:00Z",
    );
    const market = makeMarket({ ticker: "T86", close_time: "2026-07-16T05:59:00Z" });
    expect(getTargetDay(forecast, event, market, tz).index).toBe(1);
  });

  it("refuses dated events beyond the forecast window instead of guessing today", () => {
    const event = makeDatedEvent(
      "Highest temperature in Houston on Jul 30, 2026?",
      "2026-07-30T12:00:00Z",
    );
    const market = makeMarket({ ticker: "T86", close_time: "2026-07-31T05:59:00Z" });
    expect(getTargetDay(forecast, event, market, tz).index).toBe(STALE_EVENT_INDEX);
  });

  it("keeps the today fallback for genuinely undated events", () => {
    const event = makeDatedEvent("Houston temperature market", null);
    const market = makeMarket({ ticker: "T86", close_time: "2099-01-01T00:00:00Z" });
    expect(getTargetDay(forecast, event, market, tz).index).toBe(0);
  });
});

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

describe("detectMetric — hourly temperature series", () => {
  function makeEvent(overrides: Partial<KalshiEvent>): KalshiEvent {
    return {
      event_ticker: "EVT-1",
      series_ticker: "KXHIGHNY",
      title: "Highest temperature in NYC on Jul 9, 2026?",
      sub_title: "",
      category: "Climate and Weather",
      strike_date: null,
      markets: [makeMarket({ ticker: "EVT-1-M" })],
      ...overrides,
    };
  }

  it("classifies hourly-settlement series as unknown by series ticker", () => {
    expect(
      detectMetric(
        makeEvent({
          series_ticker: "KXTEMPNYCH",
          title: "New York City temperature on Jul 9, 2026 at 10am EDT?",
          sub_title: "On Jul 9, 2026 at 10am EDT",
        }),
      ),
    ).toBe("unknown");
    expect(detectMetric(makeEvent({ series_ticker: "KXTEMPLAXH", title: "Los Angeles temperature on Jul 9, 2026 at 9am EDT?" }))).toBe("unknown");
  });

  it("classifies hourly markets as unknown by title when series is missing", () => {
    expect(
      detectMetric(
        makeEvent({
          series_ticker: "",
          title: "Chicago temperature on Jul 9, 2026 at 12pm EDT?",
        }),
      ),
    ).toBe("unknown");
  });

  it("keeps daily high/low series classified as before", () => {
    expect(detectMetric(makeEvent({}))).toBe("temperature_high");
    expect(
      detectMetric(
        makeEvent({
          series_ticker: "KXLOWTCHI",
          title: "Lowest temperature in Chicago on Jul 9, 2026?",
        }),
      ),
    ).toBe("temperature_low");
  });
});
