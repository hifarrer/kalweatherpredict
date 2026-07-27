import { describe, expect, it } from "vitest";
import { localHourFor } from "@/lib/cities";

describe("localHourFor", () => {
  // 2026-07-27T18:30:00Z: EDT 14:30, CDT 13:30, MDT 12:30, MST/PDT 11:30
  const summer = new Date("2026-07-27T18:30:00.000Z");

  it("converts to each settlement timezone (DST-aware)", () => {
    expect(localHourFor("America/New_York", summer)).toBe(14);
    expect(localHourFor("America/Chicago", summer)).toBe(13);
    expect(localHourFor("America/Denver", summer)).toBe(12);
    // Phoenix does not observe DST — MST year-round
    expect(localHourFor("America/Phoenix", summer)).toBe(11);
    expect(localHourFor("America/Los_Angeles", summer)).toBe(11);
  });

  it("renders midnight as 0, not 24 (hourCycle h23)", () => {
    // 04:30Z on 7/27 = 00:30 EDT
    expect(localHourFor("America/New_York", new Date("2026-07-27T04:30:00.000Z"))).toBe(0);
  });
});
