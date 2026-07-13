import { describe, expect, it } from "vitest";
import {
  dailyAccuracy,
  GradedRow,
  reliabilityCurve,
} from "@/lib/statsAgg";
import { fillDailyGaps } from "@/lib/botStats";

const graded = (over: Partial<GradedRow>): GradedRow => ({
  market_ticker: "T",
  event_ticker: "E",
  city_code: null,
  asset: null,
  metric: "high_temp",
  lead_days: null,
  tau_hours: null,
  forecast_value: null,
  predicted_prob: 0.7,
  market_prob: null,
  target_date: null,
  result: "yes",
  actual_value: null,
  settled_at: "2026-07-10T15:00:00Z",
  ...over,
});

describe("dailyAccuracy", () => {
  it("prefers the market target_date over the settlement timestamp", () => {
    const rows = [
      // settled early: stored settled_at is days after the target day
      graded({ target_date: "2026-07-10", settled_at: "2026-07-15T15:00:00Z" }),
      graded({ target_date: "2026-07-11", settled_at: "2026-07-15T15:00:00Z" }),
    ];
    expect(dailyAccuracy(rows).map((d) => d.day)).toEqual([
      "2026-07-10",
      "2026-07-11",
    ]);
  });

  it("falls back to the US/Eastern settlement day, ascending", () => {
    const rows = [
      // 2026-07-11 01:00 UTC is still 2026-07-10 in New York (EDT = UTC-4)
      graded({ settled_at: "2026-07-11T01:00:00Z", predicted_prob: 0.8, result: "yes" }),
      graded({ settled_at: "2026-07-11T15:00:00Z", predicted_prob: 0.4, result: "yes" }),
      graded({ settled_at: "2026-07-10T15:00:00Z", predicted_prob: 0.9, result: "no" }),
    ];
    const daily = dailyAccuracy(rows);
    expect(daily.map((d) => d.day)).toEqual(["2026-07-10", "2026-07-11"]);
    // Jul 10 ET: 0.8/yes (hit) and 0.9/no (miss)
    expect(daily[0].n).toBe(2);
    expect(daily[0].hitRate).toBeCloseTo(0.5);
    // Jul 11 ET: 0.4/yes (miss)
    expect(daily[1].n).toBe(1);
    expect(daily[1].hitRate).toBe(0);
    expect(daily[1].brier).toBeCloseTo(0.36);
  });

  it("skips rows without any date and reports marketBrier only when present", () => {
    const rows = [
      graded({ settled_at: null }),
      graded({ market_prob: 0.6, result: "yes" }),
      graded({ market_prob: null, result: "yes" }),
    ];
    const daily = dailyAccuracy(rows);
    expect(daily).toHaveLength(1);
    expect(daily[0].n).toBe(2);
    expect(daily[0].marketBrier).toBeCloseTo(0.16);
  });

  it("returns [] for no gradeable rows", () => {
    expect(dailyAccuracy([graded({ settled_at: null })])).toEqual([]);
  });
});

describe("reliabilityCurve", () => {
  it("buckets deciles against observed YES frequency and drops empty buckets", () => {
    const rows = [
      graded({ predicted_prob: 0.62, result: "yes" }),
      graded({ predicted_prob: 0.65, result: "yes" }),
      graded({ predicted_prob: 0.68, result: "no" }),
      graded({ predicted_prob: 0.12, result: "no" }),
    ];
    const curve = reliabilityCurve(rows);
    expect(curve).toEqual([
      { midpoint: 0.15, observed: 0, n: 1 },
      { midpoint: 0.65, observed: 2 / 3, n: 3 },
    ]);
  });

  it("clamps predicted_prob = 1.0 into the top bucket", () => {
    const curve = reliabilityCurve([graded({ predicted_prob: 1.0, result: "yes" })]);
    expect(curve).toEqual([{ midpoint: 0.95, observed: 1, n: 1 }]);
  });
});

describe("fillDailyGaps", () => {
  const day = (over: object) => ({
    day: "2026-07-08",
    pnlCents: 0,
    wins: 0,
    losses: 0,
    closed: 0,
    ...over,
  });

  it("zero-fills missing days and accumulates running totals", () => {
    const out = fillDailyGaps([
      day({ day: "2026-07-08", pnlCents: 150, wins: 2, losses: 1, closed: 3 }),
      day({ day: "2026-07-11", pnlCents: -40, wins: 0, losses: 1, closed: 1 }),
    ]);
    expect(out.map((d) => d.day)).toEqual([
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(out[1]).toMatchObject({ pnlCents: 0, closed: 0, cumPnlCents: 150 });
    expect(out[3]).toMatchObject({
      pnlCents: -40,
      cumPnlCents: 110,
      cumWins: 2,
      cumLosses: 2,
    });
  });

  it("handles a single day and empty input", () => {
    expect(fillDailyGaps([])).toEqual([]);
    const single = fillDailyGaps([day({ pnlCents: 25, wins: 1, closed: 1 })]);
    expect(single).toHaveLength(1);
    expect(single[0].cumPnlCents).toBe(25);
  });
});
