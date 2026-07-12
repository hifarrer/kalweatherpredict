import { describe, expect, it } from "vitest";
import {
  buildRawSteps,
  DEFAULT_REPLAY_OPTS,
  modelDiagnostics,
  scoreSteps,
  simulateTrading,
  TradeParams,
} from "../replay";
import { BtDataset, BtEvent, BtKalshiCandle, BtSpotCandle } from "../btypes";
import { DEFAULT_CRYPTO_PARAMS } from "@/lib/crypto/params";

/**
 * Synthetic single-market scenario with a known outcome:
 * spot sits at 64,000 (flat, tiny noise) for 24h; a "greater 63,000" market
 * that will settle YES is quoted at 80¢ (model will say ~100%), a
 * "greater 65,000" market that settles NO is quoted at 20¢.
 * The strategy should buy YES on the first and/or NO on the second and win.
 */

const CLOSE = Date.UTC(2026, 0, 10, 21, 0, 0);
const START = CLOSE - 26 * 3600 * 1000;

function flatSpot(): BtSpotCandle[] {
  const out: BtSpotCandle[] = [];
  for (let ts = START; ts <= CLOSE; ts += 60_000) {
    // ±4bp alternating noise so realized vol is nonzero
    const p = 64_000 * Math.exp((Math.floor(ts / 60_000) % 2 === 0 ? 1 : -1) * 0.0004);
    out.push({ ts, open: p, high: p, low: p, close: p });
  }
  return out;
}

function bookCandles(bid: number, ask: number): BtKalshiCandle[] {
  const out: BtKalshiCandle[] = [];
  for (let ts = CLOSE - 2 * 3600 * 1000; ts <= CLOSE; ts += 60_000) {
    out.push({ ts, yesBid: bid, yesAsk: ask, vol: 10 });
  }
  return out;
}

function mkDataset(): BtDataset {
  const event: BtEvent = {
    eventTicker: "KXBTCD-TEST",
    seriesTicker: "KXBTCD",
    asset: "BTC",
    title: "BTC test",
    closeTs: CLOSE,
    actualValue: 64_000,
    markets: [
      {
        ticker: "T-ITM",
        strikeType: "greater",
        floor: 63_000,
        cap: null,
        result: "yes",
        volumeFp: 5000,
        candles: bookCandles(0.78, 0.8),
      },
      {
        ticker: "T-OTM",
        strikeType: "greater",
        floor: 65_000,
        cap: null,
        result: "no",
        volumeFp: 5000,
        candles: bookCandles(0.2, 0.22),
      },
    ],
  };
  return {
    fetchedAt: new Date().toISOString(),
    days: 1,
    events: [event],
    spot: { BTC: flatSpot() },
    dvol: { BTC: [{ ts: START, dvol: 0.35 }] },
  };
}

const TRADE: TradeParams = {
  minEv: 0.03,
  minWinProb: 0.4,
  minPriceCents: 40,
  maxProbGap: 1.0, // wide-open for the synthetic scenario
  maxTauHours: 2,
  minTauMinutes: 5,
  maxSpreadCents: 10,
  minVolume: 50,
  spotBackedMaxTauMin: 30,
  spotBackedMinZ: 2,
  adverseFillCents: 1,
  stakeCents: 1000,
  exits: null,
};

describe("backtest replay", () => {
  const dataset = mkDataset();
  const raw = buildRawSteps(dataset, DEFAULT_CRYPTO_PARAMS, DEFAULT_REPLAY_OPTS);

  it("builds steps only where spot and book exist", () => {
    expect(raw.length).toBeGreaterThan(10);
    for (const s of raw) {
      expect(s.spot).toBeGreaterThan(63_000);
      expect(s.tauHours).toBeGreaterThan(0);
      expect(s.markets.length).toBeGreaterThan(0);
    }
  });

  it("scores steps with near-certain probabilities for the far strikes", () => {
    const scored = scoreSteps(raw, DEFAULT_CRYPTO_PARAMS);
    const last = scored[scored.length - 1]; // closest to settlement
    const byTicker = new Map(last.markets.map((m, i) => [m.ticker, last.modelProbs[i]]));
    expect(byTicker.get("T-ITM")!).toBeGreaterThan(0.95);
    expect(byTicker.get("T-OTM")!).toBeLessThan(0.05);
  });

  it("produces sane model diagnostics", () => {
    const scored = scoreSteps(raw, DEFAULT_CRYPTO_PARAMS);
    const d = modelDiagnostics(scored);
    expect(d.n).toBeGreaterThan(0);
    // Model should easily beat 0.25 (coin flip) on this trivially-decided setup
    expect(d.brierModel).toBeLessThan(0.1);
  });

  it("buys the underpriced sides and wins at settlement", () => {
    const scored = scoreSteps(raw, DEFAULT_CRYPTO_PARAMS);
    const { trades, summary } = simulateTrading(dataset, scored, TRADE);
    // One position per event
    expect(trades.length).toBe(1);
    const t = trades[0];
    // Either YES on the ITM strike at ~81¢ or NO on the OTM at ~79¢ — both win
    expect(t.won).toBe(true);
    expect(t.pnlCents).toBeGreaterThan(0);
    expect(summary.pnlCents).toBe(t.pnlCents);
    expect(summary.winRate).toBe(1);
    // Entry respected the stake: cost ≤ $10
    expect(t.count * (t.entryCents + t.feeCents)).toBeLessThanOrEqual(1000);
  });

  it("respects the price floor filter", () => {
    const scored = scoreSteps(raw, DEFAULT_CRYPTO_PARAMS);
    const { trades } = simulateTrading(dataset, scored, {
      ...TRADE,
      minPriceCents: 95, // nothing quotes ≥95¢
    });
    expect(trades.length).toBe(0);
  });

  it("take-profit exit closes a position early when enabled", () => {
    // Book improves over time for the YES holder: bid walks 60→95¢
    const rising: BtKalshiCandle[] = [];
    for (let ts = CLOSE - 2 * 3600 * 1000, i = 0; ts <= CLOSE; ts += 60_000, i++) {
      const bid = Math.min(0.95, 0.6 + i * 0.005);
      rising.push({ ts, yesBid: bid, yesAsk: Math.min(0.99, bid + 0.02), vol: 10 });
    }
    const ds = mkDataset();
    ds.events[0].markets = [
      { ...ds.events[0].markets[0], ticker: "T-RISE", candles: rising },
    ];
    const raw2 = buildRawSteps(ds, DEFAULT_CRYPTO_PARAMS, DEFAULT_REPLAY_OPTS);
    const scored2 = scoreSteps(raw2, DEFAULT_CRYPTO_PARAMS);
    const { trades } = simulateTrading(ds, scored2, {
      ...TRADE,
      minPriceCents: 30,
      exits: { takeProfitPct: 20, stopLossPct: 50 },
    });
    expect(trades.length).toBe(1);
    expect(trades[0].exit).toBe("take_profit");
    expect(trades[0].pnlCents).toBeGreaterThan(0);
  });
});
