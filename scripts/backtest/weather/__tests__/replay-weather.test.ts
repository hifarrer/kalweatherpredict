import { describe, expect, it } from "vitest";
import {
  dedupeFirstPerTicker,
  RescoredRow,
  simulateWeather,
  WxDataset,
  WxRow,
  WxTradeParams,
} from "../replay-weather";

const EMPTY_DATASET: WxDataset = {
  version: 2,
  fetchedAt: "",
  rows: [],
  snaps: {},
  finals: [],
};

let nextId = 1;
function mkRow(over: Partial<WxRow>): WxRow {
  const id = nextId++;
  return {
    id,
    ticker: `KXHIGHTEST-${id}`,
    event: `EV-${id}`,
    side: "no",
    kind: "value",
    source: "scheduled",
    price: 0.6,
    pModel: 0.2,
    pBlendStored: 0.3,
    winProbStored: 0.7,
    pMarket: 0.4,
    fee: 0.02,
    vol24: 500,
    city: "NYC",
    metric: "temperature_high",
    lead: 0,
    targetDate: "2026-07-27",
    localHour: 15,
    ts: id * 1000,
    result: "no",
    ...over,
  };
}

const rescoreStub = (): RescoredRow => ({
  winProb: 0.8,
  ev: 0.15,
  score: 0.13,
  probGap: 0.1,
  appliedW: 0.5,
});

function params(over: Partial<WxTradeParams>): WxTradeParams {
  return {
    minEv: 0.08,
    minWinProb: 0.3,
    minScore: 0.05,
    minPriceCents: 40,
    maxPriceCents: 99,
    maxProbGap: 0.2,
    leadMode: "lead01",
    metricMode: "high_only",
    obsBackedOnly: false,
    minLocalHourLead0: 0,
    excludeCities: [],
    exits: null,
    adverseFillCents: 1,
    spreadHaircutCents: 3,
    stakeCents: 1000,
    ...over,
  };
}

describe("simulateWeather — afternoon gate", () => {
  const rows = [
    mkRow({ lead: 0, localHour: 9 }), // morning same-day — must be gated
    mkRow({ lead: 0, localHour: 15 }), // afternoon same-day — passes
    mkRow({ lead: 1, localHour: 9 }), // lead-1 — gate does not apply
    mkRow({ lead: 0, localHour: null }), // unknown hour — fails closed
  ];

  it("gates lead-0 rows before the local hour, passes lead-1 and afternoon", () => {
    const { trades } = simulateWeather(
      EMPTY_DATASET,
      rows,
      rescoreStub,
      params({ minLocalHourLead0: 13 }),
    );
    expect(trades.map((t) => t.lead)).toEqual([0, 1]);
    expect(trades).toHaveLength(2);
  });

  it("gates nothing when disabled (0)", () => {
    const { trades } = simulateWeather(EMPTY_DATASET, rows, rescoreStub, params({}));
    expect(trades).toHaveLength(4);
  });
});

describe("dedupeFirstPerTicker", () => {
  it("keeps the earliest suggestion per ticker+side, both sides survive", () => {
    const rows = [
      mkRow({ ticker: "A", side: "no", ts: 2000 }),
      mkRow({ ticker: "A", side: "no", ts: 1000 }),
      mkRow({ ticker: "A", side: "no", ts: 3000 }),
      mkRow({ ticker: "A", side: "yes", ts: 5000 }),
    ];
    const out = dedupeFirstPerTicker(rows);
    expect(out).toHaveLength(2);
    const no = out.find((r) => r.side === "no")!;
    const yes = out.find((r) => r.side === "yes")!;
    expect(no.ts).toBe(1000);
    expect(yes.ts).toBe(5000);
  });
});
