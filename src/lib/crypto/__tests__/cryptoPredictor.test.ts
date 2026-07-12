import { describe, expect, it } from "vitest";
import {
  logSpaceSigma,
  predictCryptoEvent,
  priceStrikeProb,
} from "@/lib/crypto/cryptoPredictor";
import { DEFAULT_CRYPTO_PARAMS } from "@/lib/crypto/params";
import { KalshiEvent, KalshiMarket } from "@/types";

const HOURS_PER_YEAR = 365 * 24;

function mkMarket(over: Partial<KalshiMarket>): KalshiMarket {
  return {
    ticker: "T-1",
    event_ticker: "E-1",
    yes_sub_title: "",
    no_sub_title: "",
    close_time: new Date(Date.now() + 3_600_000).toISOString(),
    latest_expiration_time: "",
    status: "active",
    yes_bid_dollars: "0.50",
    yes_ask_dollars: "0.52",
    no_bid_dollars: "0.48",
    no_ask_dollars: "0.50",
    last_price_dollars: "0.51",
    volume_fp: "1000",
    volume_24h_fp: "1000",
    open_interest_fp: "0",
    notional_value_dollars: "1",
    result: "",
    rules_primary: "",
    rules_secondary: "",
    floor_strike: null,
    cap_strike: null,
    strike_type: "",
    expiration_value: "",
    ...over,
  };
}

describe("priceStrikeProb", () => {
  it("gives ~50% for an at-the-money 'greater' strike", () => {
    // Drift-free GBM: P(S_T > S·e^{-s²/2-ish}) ≈ 0.5 at K = S for small s
    const p = priceStrikeProb(
      64000,
      { strike_type: "greater", floor_strike: 64000, cap_strike: null },
      0.4,
      1,
    );
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.47);
    expect(p!).toBeLessThan(0.53);
  });

  it("matches a hand-computed Black-Scholes digital price", () => {
    // S=100, K=105, σ=0.5/yr, τ=1 year (large numbers to be unambiguous):
    // d2 = (ln(S/K) − σ²/2·τ)/(σ√τ) = (ln(100/105) − 0.125)/0.5 = −0.34758
    // P(S_T > K) = Φ(d2) ≈ 0.36407
    const p = priceStrikeProb(
      100,
      { strike_type: "greater", floor_strike: 105, cap_strike: null },
      0.5,
      HOURS_PER_YEAR,
    );
    expect(p!).toBeCloseTo(0.36407, 3);
  });

  it("complements 'less' against 'greater' at the same strike", () => {
    const gt = priceStrikeProb(
      64000,
      { strike_type: "greater", floor_strike: 63500, cap_strike: null },
      0.35,
      2,
    );
    const lt = priceStrikeProb(
      64000,
      { strike_type: "less", floor_strike: null, cap_strike: 63500 },
      0.35,
      2,
    );
    expect(gt! + lt!).toBeCloseTo(1, 10);
  });

  it("prices 'between' as the difference of the boundary CDFs", () => {
    const args = [64000, 0.35, 2] as const;
    const between = priceStrikeProb(
      args[0],
      { strike_type: "between", floor_strike: 63500, cap_strike: 64500 },
      args[1],
      args[2],
    );
    const below = priceStrikeProb(
      args[0],
      { strike_type: "less", floor_strike: null, cap_strike: 64500 },
      args[1],
      args[2],
    );
    const belowFloor = priceStrikeProb(
      args[0],
      { strike_type: "less", floor_strike: null, cap_strike: 63500 },
      args[1],
      args[2],
    );
    expect(between!).toBeCloseTo(below! - belowFloor!, 10);
  });

  it("degenerates to a step function at τ = 0", () => {
    const above = priceStrikeProb(
      64000,
      { strike_type: "greater", floor_strike: 63000, cap_strike: null },
      0.35,
      0,
    );
    const below = priceStrikeProb(
      64000,
      { strike_type: "greater", floor_strike: 65000, cap_strike: null },
      0.35,
      0,
    );
    expect(above).toBe(1);
    expect(below).toBe(0);
  });

  it("is a martingale: E[S_T] = spot (put-call symmetry check)", () => {
    // With μ = ln(S) − s²/2 the median is below spot but the mean equals
    // spot. Sanity: P(S_T > S) < 0.5 and shrinking σ pulls it toward 0.5.
    const wide = priceStrikeProb(
      100,
      { strike_type: "greater", floor_strike: 100, cap_strike: null },
      1.0,
      HOURS_PER_YEAR,
    );
    const narrow = priceStrikeProb(
      100,
      { strike_type: "greater", floor_strike: 100, cap_strike: null },
      0.01,
      HOURS_PER_YEAR,
    );
    expect(wide!).toBeLessThan(narrow!);
    expect(narrow!).toBeCloseTo(0.5, 2);
  });

  it("rejects invalid inputs", () => {
    expect(
      priceStrikeProb(0, { strike_type: "greater", floor_strike: 1, cap_strike: null }, 0.3, 1),
    ).toBeNull();
    expect(
      priceStrikeProb(100, { strike_type: "", floor_strike: 1, cap_strike: null }, 0.3, 1),
    ).toBeNull();
    expect(
      priceStrikeProb(
        100,
        { strike_type: "between", floor_strike: 105, cap_strike: 95 },
        0.3,
        1,
      ),
    ).toBeNull();
  });
});

describe("logSpaceSigma", () => {
  it("scales with the square root of time", () => {
    const s1 = logSpaceSigma(0.4, 1);
    const s4 = logSpaceSigma(0.4, 4);
    expect(s4 / s1).toBeCloseTo(2, 10);
  });
  it("is zero for non-positive τ or σ", () => {
    expect(logSpaceSigma(0.4, 0)).toBe(0);
    expect(logSpaceSigma(0, 5)).toBe(0);
  });
});

describe("predictCryptoEvent", () => {
  const now = Date.now();
  const closeIso = new Date(now + 20 * 60 * 1000).toISOString(); // τ = 20 min

  function mkEvent(markets: KalshiMarket[]): KalshiEvent {
    return {
      event_ticker: "KXBTCD-TEST",
      series_ticker: "KXBTCD",
      title: "BTC price today at 5pm EDT?",
      sub_title: "",
      category: "Crypto",
      strike_date: closeIso,
      markets,
    };
  }

  it("produces likelihoods, matched market, and spot-backed flags", () => {
    const spot = 64000;
    const markets = [
      mkMarket({
        ticker: "T-LOW",
        close_time: closeIso,
        strike_type: "greater",
        floor_strike: 60000, // deep ITM — spot-backed lock
      }),
      mkMarket({
        ticker: "T-ATM",
        close_time: closeIso,
        strike_type: "greater",
        floor_strike: 64000, // at the money — uncertain
      }),
      mkMarket({
        ticker: "T-HIGH",
        close_time: closeIso,
        strike_type: "greater",
        floor_strike: 68000, // deep OTM — spot-backed dead
      }),
    ];
    const result = predictCryptoEvent(
      mkEvent(markets),
      { price: spot, ts: now, source: "coinbase" },
      0.35,
      { nowMs: now },
    );

    expect(result).not.toBeNull();
    expect(result!.metric).toBe("crypto_price");
    expect(result!.forecastValue).toBe(spot);
    expect(result!.tauHours).toBeCloseTo(1 / 3, 3);

    const byTicker = new Map(result!.marketLikelihoods!.map((l) => [l.ticker, l]));
    expect(byTicker.get("T-LOW")!.probability).toBeGreaterThan(0.99);
    expect(byTicker.get("T-LOW")!.obsBacked).toBe(true);
    expect(byTicker.get("T-HIGH")!.probability).toBeLessThan(0.01);
    expect(byTicker.get("T-HIGH")!.obsBacked).toBe(true);
    expect(byTicker.get("T-ATM")!.obsBacked).toBe(false);

    // Matched market = nearest strike to spot
    expect(result!.matchedMarket?.ticker).toBe("T-ATM");
    // decided must never be set for crypto
    expect(result!.marketLikelihoods!.every((l) => l.decided !== true)).toBe(true);
  });

  it("does not set spot-backed flags when τ exceeds the window", () => {
    const farClose = new Date(now + 5 * 60 * 60 * 1000).toISOString(); // τ = 5h
    const markets = [
      mkMarket({
        ticker: "T-LOW",
        close_time: farClose,
        strike_type: "greater",
        floor_strike: 50000,
      }),
    ];
    const result = predictCryptoEvent(
      mkEvent(markets),
      { price: 64000, ts: now, source: "coinbase" },
      0.35,
      { nowMs: now, params: DEFAULT_CRYPTO_PARAMS },
    );
    expect(result!.marketLikelihoods![0].probability).toBeGreaterThan(0.99);
    expect(result!.marketLikelihoods![0].obsBacked).toBe(false);
  });

  it("returns null for closed events or bad inputs", () => {
    const closed = mkEvent([
      mkMarket({ close_time: new Date(now - 1000).toISOString() }),
    ]);
    expect(
      predictCryptoEvent(closed, { price: 64000, ts: now, source: "coinbase" }, 0.35, {
        nowMs: now,
      }),
    ).toBeNull();
    expect(
      predictCryptoEvent(
        mkEvent([mkMarket({ close_time: closeIso })]),
        { price: 0, ts: now, source: "coinbase" },
        0.35,
        { nowMs: now },
      ),
    ).toBeNull();
  });
});
