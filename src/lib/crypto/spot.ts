import { CryptoAssetInfo } from "@/lib/crypto/assets";

/**
 * Free, US-accessible spot price + 1m candle feeds.
 *
 * Primary: Coinbase Exchange public API (api.exchange.coinbase.com).
 * Fallback: Kraken public API. Binance is geo-blocked for US servers.
 *
 * Every SpotInfo carries its fetch timestamp so the automation's stale-data
 * guard can refuse to trade on old prices.
 */

export interface SpotInfo {
  price: number;
  /** When the price was fetched (ms epoch). */
  ts: number;
  source: "coinbase" | "kraken";
}

export interface Candle {
  /** Candle start time, ms epoch. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const KRAKEN_BASE = "https://api.kraken.com/0/public";

const SPOT_TTL_MS = 5 * 1000;
const CANDLES_TTL_MS = 60 * 1000;
/** Coinbase returns at most 300 candles per request. */
const COINBASE_MAX_CANDLES = 300;
const FETCH_TIMEOUT_MS = 10 * 1000;

const spotCache = new Map<string, SpotInfo>();
const candleCache = new Map<string, { candles: Candle[]; ts: number }>();

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "kalshi-weather-app" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function coinbaseSpot(asset: CryptoAssetInfo): Promise<SpotInfo> {
  const data = (await fetchJson(
    `${COINBASE_BASE}/products/${asset.coinbaseProductId}/ticker`,
  )) as { price?: string };
  const price = parseFloat(data.price ?? "");
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Coinbase ticker returned bad price for ${asset.code}`);
  }
  return { price, ts: Date.now(), source: "coinbase" };
}

async function krakenSpot(asset: CryptoAssetInfo): Promise<SpotInfo> {
  const data = (await fetchJson(
    `${KRAKEN_BASE}/Ticker?pair=${asset.krakenPair}`,
  )) as { error?: string[]; result?: Record<string, { c?: string[] }> };
  if (data.error?.length) throw new Error(`Kraken: ${data.error.join(", ")}`);
  const first = Object.values(data.result ?? {})[0];
  const price = parseFloat(first?.c?.[0] ?? "");
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Kraken ticker returned bad price for ${asset.code}`);
  }
  return { price, ts: Date.now(), source: "kraken" };
}

/**
 * Current spot price with a 5s cache. Tries Coinbase, falls back to Kraken;
 * throws only when both feeds fail.
 */
export async function getSpot(asset: CryptoAssetInfo): Promise<SpotInfo> {
  const cached = spotCache.get(asset.code);
  if (cached && Date.now() - cached.ts < SPOT_TTL_MS) return cached;

  let spot: SpotInfo;
  try {
    spot = await coinbaseSpot(asset);
  } catch (err) {
    console.warn(`[crypto/spot] Coinbase spot failed for ${asset.code}:`, err);
    spot = await krakenSpot(asset);
  }
  spotCache.set(asset.code, spot);
  return spot;
}

/** Coinbase candles: array of [time_sec, low, high, open, close, volume], newest first. */
async function coinbaseCandles(
  asset: CryptoAssetInfo,
  startMs: number,
  endMs: number,
  granularitySec: number,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    granularity: String(granularitySec),
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  });
  const data = (await fetchJson(
    `${COINBASE_BASE}/products/${asset.coinbaseProductId}/candles?${params}`,
  )) as number[][];
  return data
    .map((c) => ({ ts: c[0] * 1000, low: c[1], high: c[2], open: c[3], close: c[4] }))
    .sort((a, b) => a.ts - b.ts);
}

/** Kraken OHLC: rows of [time_sec, open, high, low, close, vwap, volume, count]. */
async function krakenCandles(
  asset: CryptoAssetInfo,
  sinceMs: number,
  granularitySec: number,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    pair: asset.krakenPair,
    interval: String(Math.max(1, Math.round(granularitySec / 60))),
    since: String(Math.floor(sinceMs / 1000)),
  });
  const data = (await fetchJson(`${KRAKEN_BASE}/OHLC?${params}`)) as {
    error?: string[];
    result?: Record<string, unknown>;
  };
  if (data.error?.length) throw new Error(`Kraken: ${data.error.join(", ")}`);
  const rows = Object.entries(data.result ?? {}).find(([k]) => k !== "last")?.[1] as
    | (string | number)[][]
    | undefined;
  return (rows ?? [])
    .map((r) => ({
      ts: Number(r[0]) * 1000,
      open: parseFloat(String(r[1])),
      high: parseFloat(String(r[2])),
      low: parseFloat(String(r[3])),
      close: parseFloat(String(r[4])),
    }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Recent 1m candles covering the trailing `minutes` window (cached 60s).
 * Coinbase first, Kraken fallback. Used by the realized-vol estimator, which
 * tolerates small gaps, so no gap-filling is attempted.
 */
export async function getRecentCandles(
  asset: CryptoAssetInfo,
  minutes: number,
): Promise<Candle[]> {
  const key = `${asset.code}:${minutes}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.ts < CANDLES_TTL_MS) return cached.candles;

  const end = Date.now();
  const start = end - minutes * 60 * 1000;
  let candles: Candle[];
  try {
    if (minutes <= COINBASE_MAX_CANDLES) {
      candles = await coinbaseCandles(asset, start, end, 60);
    } else {
      candles = await getCandleRange(asset, start, end, 60);
    }
  } catch (err) {
    console.warn(`[crypto/spot] Coinbase candles failed for ${asset.code}:`, err);
    candles = await krakenCandles(asset, start, 60);
  }
  candleCache.set(key, { candles, ts: Date.now() });
  return candles;
}

/**
 * Arbitrary candle range, paged in Coinbase-sized chunks (300 candles each,
 * ~150ms apart). Chunks that fail on Coinbase are retried on Kraken; a chunk
 * that fails on both is skipped (callers tolerate gaps). Used by the backtest
 * data fetcher and vol cold-starts.
 */
export async function getCandleRange(
  asset: CryptoAssetInfo,
  startMs: number,
  endMs: number,
  granularitySec = 60,
): Promise<Candle[]> {
  const chunkMs = COINBASE_MAX_CANDLES * granularitySec * 1000;
  const out: Candle[] = [];

  for (let s = startMs; s < endMs; s += chunkMs) {
    const e = Math.min(s + chunkMs, endMs);
    try {
      out.push(...(await coinbaseCandles(asset, s, e, granularitySec)));
    } catch (err) {
      console.warn(
        `[crypto/spot] Coinbase chunk ${new Date(s).toISOString()} failed, trying Kraken:`,
        err,
      );
      try {
        const kr = await krakenCandles(asset, s, granularitySec);
        out.push(...kr.filter((c) => c.ts >= s && c.ts < e));
      } catch (err2) {
        console.warn(`[crypto/spot] Kraken chunk also failed — skipping:`, err2);
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  // Dedupe on ts (chunk boundaries can overlap) and sort ascending
  const byTs = new Map<number, Candle>();
  for (const c of out) byTs.set(c.ts, c);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
