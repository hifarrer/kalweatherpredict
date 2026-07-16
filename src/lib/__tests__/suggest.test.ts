import { describe, expect, it } from "vitest";
import {
  blendProbability,
  computeSuggestedActions,
  kalshiFeePerContract,
  SUGGEST_MIN_EV,
  SUGGEST_MIN_WINPROB,
} from "@/lib/suggest";
import { EnrichedEvent, KalshiEvent, KalshiMarket, MarketLikelihood, PredictionResult } from "@/types";

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

function makeEnriched(
  markets: KalshiMarket[],
  likelihoods: MarketLikelihood[],
  forecastValue: number | null,
  subcategory: EnrichedEvent["subcategory"] = "temperature_low",
): EnrichedEvent {
  const event: KalshiEvent = {
    event_ticker: "EVT",
    series_ticker: "SER",
    title: "Lowest temperature in Philadelphia on Jul 4, 2026?",
    sub_title: "",
    category: "Climate",
    strike_date: null,
    markets,
  };
  const prediction: PredictionResult = {
    verdict: "YES",
    forecastValue,
    matchedMarket: null,
    detail: "",
    metric: "temperature_low",
    unit: "°F",
    marketLikelihoods: likelihoods,
  };
  return {
    event,
    cityCode: "PHIL",
    volume: 0,
    volume24h: 1000,
    earliestClose: "2099-01-01T00:00:00Z",
    prediction,
    subcategory,
  };
}

describe("kalshiFeePerContract", () => {
  it("matches the ceil-to-cent fee table", () => {
    expect(kalshiFeePerContract(0.5)).toBe(0.02); // 0.07*0.25 = 1.75¢ → 2¢
    expect(kalshiFeePerContract(0.01)).toBe(0.01);
    expect(kalshiFeePerContract(0.99)).toBe(0.01);
    expect(kalshiFeePerContract(0.1)).toBe(0.01); // 0.63¢ → 1¢
  });
});

describe("blendProbability", () => {
  it("shrinks hard toward an extreme market price (Philly longshot)", () => {
    const { pBlend, w } = blendProbability(0.08, 0.01, 500, false);
    // tailFactor = max(0.25, 0.01/0.10) = 0.25 → w = 0.65 * 0.25
    expect(w).toBeCloseTo(0.1625, 4);
    expect(pBlend).toBeCloseTo(0.1625 * 0.08 + 0.8375 * 0.01, 4); // ≈ 0.0214
    expect(pBlend).toBeLessThan(0.03);
  });

  it("keeps full model weight for decided outcomes", () => {
    const { pBlend, w } = blendProbability(0.99, 0.5, 500, true);
    expect(w).toBe(1);
    expect(pBlend).toBe(0.99);
  });

  it("keeps full model weight when there is no market price", () => {
    const { pBlend, w } = blendProbability(0.3, null, 500, false);
    expect(w).toBe(1);
    expect(pBlend).toBe(0.3);
  });

  it("uses the base weight for mid-range prices with mild disagreement", () => {
    const { pBlend, w } = blendProbability(0.6, 0.45, 500, false);
    expect(w).toBeCloseTo(0.65, 4);
    expect(pBlend).toBeCloseTo(0.65 * 0.6 + 0.35 * 0.45, 4); // 0.5475
  });

  it("penalizes huge model-market disagreement", () => {
    const { w } = blendProbability(0.9, 0.3, 500, false); // d = 0.6 ≥ 0.5
    expect(w).toBeCloseTo(0.65 * 0.5, 4);
  });

  it("trusts high-volume markets more", () => {
    const { w } = blendProbability(0.6, 0.45, 5000, false);
    expect(w).toBeCloseTo(0.65 * 0.8, 4);
  });

  it("skips tail/disagreement shrinkage for observation-backed probabilities", () => {
    // Heatwave: obs say the low is locked ≥84 (model 99.6%), market still at 1¢
    const { pBlend, w } = blendProbability(0.996, 0.01, 500, false, true);
    expect(w).toBeCloseTo(0.65, 4);
    expect(pBlend).toBeCloseTo(0.65 * 0.996 + 0.35 * 0.01, 4); // ≈ 0.651
  });

  it("demotes a 'decided' outcome that contradicts the market by 50+ points", () => {
    // KXLOWTPHIL-26JUL14-T67: the obs pipeline called the outcome decided at
    // P(yes)=0.001 while the market traded at 71¢ — and the market was right.
    // A liquid book is never that wrong about an observed fact, so decided
    // must demote to the obs-backed blend instead of taking 100% weight.
    const { pBlend, w } = blendProbability(0.001, 0.71, 500, true);
    expect(w).toBeCloseTo(0.65, 4);
    expect(pBlend).toBeCloseTo(0.65 * 0.001 + 0.35 * 0.71, 4); // ≈ 0.249
    // The NO side of this blend stays well below auto-trade certainty
    expect(1 - pBlend).toBeLessThan(0.99);
  });

  it("keeps decided outcomes decided when the market roughly agrees", () => {
    const { pBlend, w } = blendProbability(0.999, 0.85, 500, true);
    expect(w).toBe(1);
    expect(pBlend).toBe(0.999);
  });
});

describe("computeSuggestedActions", () => {
  it("filters the 1¢ longshot the Philly bug reported", () => {
    // Buckets around the 79° forecast low, plus the bogus "84 and above" tail
    const markets = [
      makeMarket({ ticker: "T77", floor_strike: 77, cap_strike: 78, yes_ask_dollars: "0.30", no_ask_dollars: "0.75", yes_bid_dollars: "0.25" }),
      makeMarket({ ticker: "T79", floor_strike: 79, cap_strike: 80, yes_ask_dollars: "0.48", no_ask_dollars: "0.55", yes_bid_dollars: "0.45" }),
      makeMarket({ ticker: "T81", floor_strike: 81, cap_strike: 82, yes_ask_dollars: "0.15", no_ask_dollars: "0.90", yes_bid_dollars: "0.10" }),
      makeMarket({ ticker: "T84", strike_type: "greater", floor_strike: 84, cap_strike: null, yes_ask_dollars: "0.01", no_ask_dollars: "0.995", yes_bid_dollars: "0.005" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "T77", probability: 0.25, marketProb: 0.27 },
      { ticker: "T79", probability: 0.5, marketProb: 0.52 },
      { ticker: "T81", probability: 0.12, marketProb: 0.12 },
      { ticker: "T84", probability: 0.08, marketProb: 0.01 }, // fat Gaussian tail
    ];
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, 79));

    const longshot = suggestions.find((s) => s.ticker === "T84" && s.side === "yes");
    expect(longshot).toBeUndefined();
    // The forecast-center bucket should still be suggested (consensus)
    expect(suggestions.some((s) => s.ticker === "T79" && s.side === "yes")).toBe(true);
  });

  it("keeps a genuine value pick and reports fee-adjusted EV (weather w=0.2)", () => {
    const markets = [
      makeMarket({ ticker: "VAL", strike_type: "greater", floor_strike: 60, cap_strike: null, yes_ask_dollars: "0.50", no_ask_dollars: "0.52", yes_bid_dollars: "0.48" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "VAL", probability: 0.75, marketProb: 0.55 },
    ];
    // forecastValue null → no consensus promotion, pure value pick
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, null));

    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    expect(s.side).toBe("yes");
    // weather blend weight 0.2: 0.2·0.75 + 0.8·0.55 = 0.59
    expect(s.winProb).toBeCloseTo(0.59, 4);
    expect(s.feePerContract).toBe(0.02);
    expect(s.evPerContract).toBeCloseTo(0.59 - 0.5 - 0.02, 4); // +7¢
    expect(s.evPerContract).toBeGreaterThanOrEqual(SUGGEST_MIN_EV);
    expect(s.winProb).toBeGreaterThanOrEqual(SUGGEST_MIN_WINPROB);
    expect(s.blendWeight).toBeCloseTo(0.2, 4);
  });

  it("crypto scoring pins the backtest-validated 0.65 blend weight", () => {
    // Identical inputs to the old shared-weight behavior — crypto must be
    // byte-identical after the per-section split (its params are
    // backtest-validated; only weather's weight changed).
    const markets = [
      makeMarket({ ticker: "VAL", strike_type: "greater", floor_strike: 60, cap_strike: null, yes_ask_dollars: "0.46", no_ask_dollars: "0.56", yes_bid_dollars: "0.44" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "VAL", probability: 0.6, marketProb: 0.45 },
    ];
    const suggestions = computeSuggestedActions(
      makeEnriched(markets, likelihoods, null, "crypto_price"),
    );

    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    expect(s.winProb).toBeCloseTo(0.65 * 0.6 + 0.35 * 0.45, 4); // 0.5475
    expect(s.evPerContract).toBeCloseTo(0.5475 - 0.46 - 0.02, 4); // +6.75¢
    expect(s.blendWeight).toBeCloseTo(0.65, 4);

    // The same inputs under the weather weight fall below the EV floor:
    // 0.2·0.6 + 0.8·0.45 = 0.48 → EV 0.00. Fewer weather picks is the point.
    const weather = computeSuggestedActions(makeEnriched(markets, likelihoods, null));
    expect(weather).toHaveLength(0);
  });

  it("drops consensus picks with negative fee-adjusted EV", () => {
    const markets = [
      makeMarket({ ticker: "CON", floor_strike: 79, cap_strike: 80, yes_ask_dollars: "0.52", no_ask_dollars: "0.50", yes_bid_dollars: "0.48" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "CON", probability: 0.4, marketProb: 0.4 },
    ];
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, 79));

    // Blended 40% vs 52¢ ask + 2¢ fee → −14¢ EV: not a suggestion, even as consensus.
    // (NO side: 60% vs 50¢ ask + 2¢ fee → +8¢ EV survives as value.)
    expect(suggestions.some((s) => s.ticker === "CON" && s.side === "yes")).toBe(false);
    expect(suggestions.some((s) => s.ticker === "CON" && s.side === "no")).toBe(true);
  });

  it("still filters tail picks via the win-probability floor when no market price exists", () => {
    const markets = [
      makeMarket({ ticker: "NOMKT", strike_type: "greater", floor_strike: 84, cap_strike: null, yes_ask_dollars: "0.01", no_ask_dollars: "0", yes_bid_dollars: "0", last_price_dollars: "0" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "NOMKT", probability: 0.08, marketProb: 0 },
    ];
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, null));
    // pBlend = pModel = 0.08 (no blendable price), EV +6¢ — but winProb < 15% floor
    expect(suggestions).toHaveLength(0);
  });

  it("surfaces an observation-backed edge the market has not priced in", () => {
    // Philly heatwave: station low already 84.2, model 99.6% on "84 or above",
    // market asleep at 1¢. This is a real edge and must be suggested.
    const markets = [
      makeMarket({ ticker: "T83", strike_type: "greater", floor_strike: 83, cap_strike: null, yes_ask_dollars: "0.01", no_ask_dollars: "0.995", yes_bid_dollars: "0.005", last_price_dollars: "0.01" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "T83", probability: 0.996, marketProb: 0.01, obsBacked: true },
    ];
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, null));

    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    expect(s.side).toBe("yes");
    // weather obs-backed weight 0.5: 0.5·0.996 + 0.5·0.01 ≈ 0.503
    expect(s.winProb).toBeCloseTo(0.503, 2);
    expect(s.evPerContract).toBeGreaterThan(0.45);
    expect(s.rationale).toContain("station observations");
    expect(s.obsBacked).toBe(true);
  });

  it("never emits a 99%+ pick against a market pinned at the opposite extreme", () => {
    // KXHIGHTHOU-26JUL13-T86 shape: wrong-station obs pinned the model to
    // P(yes)=0.001 and "decided" while the book screamed 99.7¢ YES. The old
    // blendableMarketProb returned null at extreme prices (no valid mid), so
    // the broken model kept 100% weight and a win_prob 0.999 NO was suggested
    // (it lost). Extreme prices now clamp to 0.99/0.01 and the decided guard
    // demotes, so no certainty-level suggestion can survive.
    const markets = [
      makeMarket({
        ticker: "T86",
        strike_type: "greater",
        floor_strike: 86,
        cap_strike: null,
        yes_ask_dollars: "0",
        no_ask_dollars: "0.05",
        yes_bid_dollars: "0",
        last_price_dollars: "0.997",
      }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "T86", probability: 0.001, marketProb: 0.997, decided: true },
    ];
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, null));
    for (const s of suggestions) {
      expect(s.winProb).toBeLessThan(0.99);
    }
  });

  it("ranks by risk-adjusted score, not raw EV", () => {
    const markets = [
      // Longshot-ish but above floors: 20% win at 10¢ ask → EV +9¢, score 0.09*sqrt(0.2)=0.040
      makeMarket({ ticker: "LONG", strike_type: "greater", floor_strike: 70, cap_strike: null, yes_ask_dollars: "0.10", no_ask_dollars: "0.92", yes_bid_dollars: "0.08" }),
      // Solid: 65% win at 57¢ ask → EV +6¢, score 0.06*sqrt(0.65)=0.048 → should rank first
      makeMarket({ ticker: "SOLID", strike_type: "greater", floor_strike: 60, cap_strike: null, yes_ask_dollars: "0.57", no_ask_dollars: "0.45", yes_bid_dollars: "0.55" }),
    ];
    const likelihoods: MarketLikelihood[] = [
      { ticker: "LONG", probability: 0.2, marketProb: 0.2 },
      { ticker: "SOLID", probability: 0.65, marketProb: 0.65 },
    ];
    const suggestions = computeSuggestedActions(makeEnriched(markets, likelihoods, null));
    const yesPicks = suggestions.filter((s) => s.side === "yes");
    expect(yesPicks.length).toBe(2);
    expect(yesPicks[0].ticker).toBe("SOLID");
    expect(yesPicks[0].score).toBeGreaterThan(yesPicks[1].score);
  });
});
