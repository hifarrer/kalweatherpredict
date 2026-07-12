import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CRYPTO_ASSETS } from "@/lib/crypto/assets";
import { getCandleRange } from "@/lib/crypto/spot";
import { parseSettlementValue } from "@/lib/crypto/cryptoHistory";
import { KalshiEvent, KalshiMarket } from "@/types";
import { BtDataset, BtDvolPoint, BtEvent, BtKalshiCandle, BtSpotCandle } from "./btypes";

/**
 * Backtest data acquisition. Everything is cached under backtest-data/ so
 * re-runs are incremental: settled events and their candlesticks never
 * change, so cached files are trusted forever.
 */

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";
const DATA_DIR = "backtest-data";
/** Only fetch order-book history for markets that actually traded. */
const MIN_MARKET_VOLUME = 50;
/** How much pre-close history to pull per market (matches max τ we trade). */
const CANDLE_LOOKBACK_HOURS = 8;
const SLEEP_MS = 130;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function kalshiJson(path: string, params: URLSearchParams): Promise<unknown> {
  const url = `${KALSHI_BASE}${path}?${params}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`${url} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`${url} → rate-limited after retries`);
}

/** Settled events for one series, newest first, until the cutoff date. */
async function fetchSettledEvents(
  seriesTicker: string,
  cutoffMs: number,
  maxEvents: number,
): Promise<KalshiEvent[]> {
  const out: KalshiEvent[] = [];
  let cursor = "";
  while (out.length < maxEvents) {
    const params = new URLSearchParams({
      series_ticker: seriesTicker,
      status: "settled",
      with_nested_markets: "true",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);
    const data = (await kalshiJson("/events", params)) as {
      events?: KalshiEvent[];
      cursor?: string;
    };
    const page = data.events ?? [];
    let pastCutoff = false;
    for (const e of page) {
      const closeMs = eventCloseMs(e);
      if (closeMs === null) continue;
      if (closeMs < cutoffMs) {
        pastCutoff = true;
        break;
      }
      out.push(e);
    }
    cursor = data.cursor || "";
    if (pastCutoff || !cursor || page.length === 0) break;
    await sleep(SLEEP_MS);
  }
  return out.slice(0, maxEvents);
}

function eventCloseMs(e: KalshiEvent): number | null {
  const times = (e.markets ?? [])
    .map((m) => (m.close_time ? new Date(m.close_time).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  return times.length > 0 ? Math.min(...times) : null;
}

interface RawCandlestick {
  end_period_ts: number;
  volume_fp?: string;
  yes_bid?: { close_dollars?: string };
  yes_ask?: { close_dollars?: string };
}

async function fetchMarketCandles(
  seriesTicker: string,
  marketTicker: string,
  closeMs: number,
): Promise<BtKalshiCandle[]> {
  const params = new URLSearchParams({
    start_ts: String(Math.floor(closeMs / 1000) - CANDLE_LOOKBACK_HOURS * 3600),
    end_ts: String(Math.floor(closeMs / 1000)),
    period_interval: "1",
  });
  const data = (await kalshiJson(
    `/series/${seriesTicker}/markets/${encodeURIComponent(marketTicker)}/candlesticks`,
    params,
  )) as { candlesticks?: RawCandlestick[] };
  return (data.candlesticks ?? []).map((c) => ({
    ts: c.end_period_ts * 1000,
    yesBid: parseFloat(c.yes_bid?.close_dollars ?? "0") || 0,
    yesAsk: parseFloat(c.yes_ask?.close_dollars ?? "0") || 0,
    vol: parseFloat(c.volume_fp ?? "0") || 0,
  }));
}

/** Fetch (or load cached) one settled event + candlesticks for liquid markets. */
async function fetchEvent(e: KalshiEvent, asset: string): Promise<BtEvent | null> {
  const closeMs = eventCloseMs(e);
  if (closeMs === null) return null;

  const cachePath = join(DATA_DIR, "events", `${e.event_ticker}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8")) as BtEvent;
  }

  const liquid = (e.markets ?? []).filter(
    (m) =>
      (m.result === "yes" || m.result === "no") &&
      parseFloat(m.volume_fp || "0") >= MIN_MARKET_VOLUME,
  );
  if (liquid.length === 0) return null;

  const markets: BtMarketWithCandles[] = [];
  for (const m of liquid) {
    try {
      const candles = await fetchMarketCandles(e.series_ticker, m.ticker, closeMs);
      if (candles.length > 0) {
        markets.push({
          ticker: m.ticker,
          strikeType: m.strike_type,
          floor: m.floor_strike,
          cap: m.cap_strike,
          result: m.result as "yes" | "no",
          volumeFp: parseFloat(m.volume_fp || "0"),
          candles,
        });
      }
    } catch (err) {
      console.warn(`  candles failed for ${m.ticker}: ${(err as Error).message}`);
    }
    await sleep(SLEEP_MS);
  }
  if (markets.length === 0) return null;

  const actualValue = parseSettlementValue(liquid[0]?.expiration_value);
  const btEvent: BtEvent = {
    eventTicker: e.event_ticker,
    seriesTicker: e.series_ticker,
    asset,
    title: e.title,
    closeTs: closeMs,
    actualValue,
    markets,
  };
  ensureDir(join(DATA_DIR, "events"));
  writeFileSync(cachePath, JSON.stringify(btEvent));
  return btEvent;
}

type BtMarketWithCandles = BtEvent["markets"][number];

async function fetchDvol(currency: string, startMs: number, endMs: number): Promise<BtDvolPoint[]> {
  const out: BtDvolPoint[] = [];
  const chunk = 3 * 24 * 3600 * 1000;
  for (let s = startMs; s < endMs; s += chunk) {
    const params = new URLSearchParams({
      currency,
      resolution: "3600",
      start_timestamp: String(s),
      end_timestamp: String(Math.min(s + chunk, endMs)),
    });
    try {
      const res = await fetch(
        `https://www.deribit.com/api/v2/public/get_volatility_index_data?${params}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          result?: { data?: [number, number, number, number, number][] };
        };
        for (const row of data.result?.data ?? []) {
          out.push({ ts: row[0], dvol: row[4] / 100 });
        }
      }
    } catch (err) {
      console.warn(`  DVOL chunk failed: ${(err as Error).message}`);
    }
    await sleep(SLEEP_MS);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface FetchOptions {
  days: number;
  maxEventsPerSeries: number;
  assets: string[];
}

export async function fetchDataset(opts: FetchOptions): Promise<BtDataset> {
  ensureDir(DATA_DIR);
  const endMs = Date.now();
  const cutoffMs = endMs - opts.days * 24 * 3600 * 1000;

  const assets = CRYPTO_ASSETS.filter((a) => opts.assets.includes(a.code));
  const events: BtEvent[] = [];
  const spot: Record<string, BtSpotCandle[]> = {};
  const dvol: Record<string, BtDvolPoint[]> = {};

  for (const asset of assets) {
    // 1) Spot candles (cached per asset+window-day)
    const spotPath = join(DATA_DIR, `spot-${asset.code}-${opts.days}d.json`);
    if (existsSync(spotPath)) {
      spot[asset.code] = JSON.parse(readFileSync(spotPath, "utf8"));
      console.log(`[fetch] ${asset.code}: spot candles from cache (${spot[asset.code].length})`);
    } else {
      console.log(`[fetch] ${asset.code}: fetching ${opts.days}d of 1m spot candles...`);
      // Extra day of lead-in so 24h realized vol works at window start
      spot[asset.code] = await getCandleRange(
        asset,
        cutoffMs - 24 * 3600 * 1000,
        endMs,
        60,
      );
      writeFileSync(spotPath, JSON.stringify(spot[asset.code]));
      console.log(`[fetch] ${asset.code}: ${spot[asset.code].length} spot candles`);
    }

    // 2) DVOL history
    const dvolPath = join(DATA_DIR, `dvol-${asset.code}-${opts.days}d.json`);
    if (existsSync(dvolPath)) {
      dvol[asset.code] = JSON.parse(readFileSync(dvolPath, "utf8"));
    } else {
      dvol[asset.code] = await fetchDvol(asset.deribitCurrency, cutoffMs - 24 * 3600 * 1000, endMs);
      writeFileSync(dvolPath, JSON.stringify(dvol[asset.code]));
    }
    console.log(`[fetch] ${asset.code}: ${dvol[asset.code].length} DVOL points`);

    // 3) Settled events + market candlesticks
    for (const seriesTicker of asset.kalshiSeriesTickers) {
      console.log(`[fetch] listing settled ${seriesTicker} events...`);
      const settled = await fetchSettledEvents(seriesTicker, cutoffMs, opts.maxEventsPerSeries);
      console.log(`[fetch] ${seriesTicker}: ${settled.length} settled events in window`);
      let done = 0;
      for (const e of settled) {
        const bt = await fetchEvent(e, asset.code);
        if (bt) events.push(bt);
        done++;
        if (done % 25 === 0) console.log(`[fetch] ${seriesTicker}: ${done}/${settled.length}`);
      }
    }
  }

  const dataset: BtDataset = {
    fetchedAt: new Date().toISOString(),
    days: opts.days,
    events,
    spot,
    dvol,
  };
  writeFileSync(join(DATA_DIR, "manifest.json"), JSON.stringify({
    fetchedAt: dataset.fetchedAt,
    days: opts.days,
    assets: opts.assets,
    eventCount: events.length,
    eventTickers: events.map((e) => e.eventTicker),
  }));
  console.log(`[fetch] done: ${events.length} events with candlesticks`);
  return dataset;
}

/** Load a previously fetched dataset from the cache directory. */
export function loadDataset(): BtDataset {
  const manifestPath = join(DATA_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("No backtest data — run `npm run backtest:fetch` first");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    fetchedAt: string;
    days: number;
    assets: string[];
    eventTickers: string[];
  };

  const events: BtEvent[] = [];
  for (const t of manifest.eventTickers) {
    const p = join(DATA_DIR, "events", `${t}.json`);
    if (existsSync(p)) events.push(JSON.parse(readFileSync(p, "utf8")));
  }
  const spot: Record<string, BtSpotCandle[]> = {};
  const dvol: Record<string, BtDvolPoint[]> = {};
  for (const code of manifest.assets) {
    const sp = join(DATA_DIR, `spot-${code}-${manifest.days}d.json`);
    const dp = join(DATA_DIR, `dvol-${code}-${manifest.days}d.json`);
    if (existsSync(sp)) spot[code] = JSON.parse(readFileSync(sp, "utf8"));
    if (existsSync(dp)) dvol[code] = JSON.parse(readFileSync(dp, "utf8"));
  }
  return { fetchedAt: manifest.fetchedAt, days: manifest.days, events, spot, dvol };
}
