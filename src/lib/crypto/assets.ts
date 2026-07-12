/**
 * Crypto asset registry — the crypto analog of cities.ts.
 *
 * Kalshi's BTC/ETH price markets settle on CF Benchmarks real-time indices;
 * Coinbase spot is the closest freely available proxy (it is a constituent
 * exchange of the index). Series tickers verified against the live public
 * API (2026-07): KX{BTC,ETH}D are "price above/below at <time>" ladders and
 * KX{BTC,ETH} are "price range at <time>" ladders — both hourly frequency,
 * standard quadratic fee (multiplier 1), so kalshiFeePerContract applies.
 */

export interface CryptoAssetInfo {
  code: string; // "BTC" | "ETH" — extensible
  label: string;
  /** Kalshi series whose events belong to this asset. */
  kalshiSeriesTickers: string[];
  /** Coinbase Exchange product id for spot + candles. */
  coinbaseProductId: string;
  /** Kraken public API pair (fallback spot/candles source). */
  krakenPair: string;
  /** Deribit currency for the DVOL implied-volatility index. */
  deribitCurrency: string;
}

export const CRYPTO_ASSETS: CryptoAssetInfo[] = [
  {
    code: "BTC",
    label: "Bitcoin",
    kalshiSeriesTickers: ["KXBTCD", "KXBTC"],
    coinbaseProductId: "BTC-USD",
    krakenPair: "XBTUSD",
    deribitCurrency: "BTC",
  },
  {
    code: "ETH",
    label: "Ethereum",
    kalshiSeriesTickers: ["KXETHD", "KXETH"],
    coinbaseProductId: "ETH-USD",
    krakenPair: "ETHUSD",
    deribitCurrency: "ETH",
  },
];

export const ASSET_MAP: Record<string, CryptoAssetInfo> = Object.fromEntries(
  CRYPTO_ASSETS.map((a) => [a.code, a]),
);

/** All Kalshi series tickers the crypto section syncs. */
export const CRYPTO_SERIES_TICKERS: string[] = CRYPTO_ASSETS.flatMap(
  (a) => a.kalshiSeriesTickers,
);

const SERIES_TO_ASSET: Record<string, CryptoAssetInfo> = Object.fromEntries(
  CRYPTO_ASSETS.flatMap((a) => a.kalshiSeriesTickers.map((t) => [t, a])),
);

/** Resolve an asset from a Kalshi series ticker (exact match only). */
export function detectAsset(seriesTicker: string): CryptoAssetInfo | null {
  return SERIES_TO_ASSET[seriesTicker] ?? null;
}
