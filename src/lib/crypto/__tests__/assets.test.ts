import { describe, expect, it } from "vitest";
import {
  ASSET_MAP,
  CRYPTO_ASSETS,
  CRYPTO_SERIES_TICKERS,
  detectAsset,
} from "@/lib/crypto/assets";

describe("crypto asset registry", () => {
  it("resolves every registered series ticker to its asset", () => {
    expect(detectAsset("KXBTCD")?.code).toBe("BTC");
    expect(detectAsset("KXBTC")?.code).toBe("BTC");
    expect(detectAsset("KXETHD")?.code).toBe("ETH");
    expect(detectAsset("KXETH")?.code).toBe("ETH");
  });

  it("does not match unrelated series", () => {
    expect(detectAsset("KXBTCMAXY")).toBeNull(); // yearly one-touch, not a price ladder
    expect(detectAsset("KXHIGHNY")).toBeNull();
    expect(detectAsset("")).toBeNull();
  });

  it("keeps the map and flat ticker list consistent", () => {
    expect(Object.keys(ASSET_MAP).sort()).toEqual(
      CRYPTO_ASSETS.map((a) => a.code).sort(),
    );
    expect(new Set(CRYPTO_SERIES_TICKERS).size).toBe(CRYPTO_SERIES_TICKERS.length);
    for (const a of CRYPTO_ASSETS) {
      expect(a.coinbaseProductId).toMatch(/-USD$/);
      expect(a.kalshiSeriesTickers.length).toBeGreaterThan(0);
    }
  });
});
