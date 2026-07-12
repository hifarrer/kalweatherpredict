import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRYPTO_AUTOMATION_SETTINGS,
  sanitizeCryptoSettings,
} from "@/lib/crypto/cryptoSettings";

describe("sanitizeCryptoSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(sanitizeCryptoSettings(null)).toEqual(DEFAULT_CRYPTO_AUTOMATION_SETTINGS);
    expect(sanitizeCryptoSettings("nope")).toEqual(DEFAULT_CRYPTO_AUTOMATION_SETTINGS);
    expect(sanitizeCryptoSettings({})).toEqual(DEFAULT_CRYPTO_AUTOMATION_SETTINGS);
  });

  it("ships disabled by default", () => {
    expect(DEFAULT_CRYPTO_AUTOMATION_SETTINGS.enabled).toBe(false);
  });

  it("clamps out-of-range values", () => {
    const s = sanitizeCryptoSettings({
      budgetCents: -5,
      maxPerTradeCents: 99_999_999,
      minWinProb: 7,
      minPriceCents: 300,
      maxTauHours: 10_000,
      minTauMinutes: -10,
      maxPerAsset: 0,
      maxSpreadCents: 500,
      maxSpotAgeSec: 1,
      volSpikeMult: 0,
    });
    expect(s.budgetCents).toBe(100);
    expect(s.maxPerTradeCents).toBe(1_000_000);
    expect(s.minWinProb).toBe(0.99);
    expect(s.minPriceCents).toBe(99);
    expect(s.maxTauHours).toBe(168);
    expect(s.minTauMinutes).toBe(0);
    expect(s.maxPerAsset).toBe(1);
    expect(s.maxSpreadCents).toBe(99);
    expect(s.maxSpotAgeSec).toBe(5);
    expect(s.volSpikeMult).toBe(1);
  });

  it("keeps valid values and ignores junk keys", () => {
    const s = sanitizeCryptoSettings({
      enabled: true,
      maxTauHours: 3,
      spotBackedOnly: true,
      evilKey: "ignored",
    });
    expect(s.enabled).toBe(true);
    expect(s.maxTauHours).toBe(3);
    expect(s.spotBackedOnly).toBe(true);
    expect("evilKey" in s).toBe(false);
  });
});
