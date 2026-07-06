import { constants, createSign, createPrivateKey, type KeyObject } from "node:crypto";

/**
 * Authenticated Kalshi trade-API client (order placement, balance).
 *
 * Separate from the read-only client in kalshi.ts: these endpoints require
 * RSA-PSS request signing with the account's API key. Credentials come from
 * env vars today; getKalshiCredentials() is the seam where a per-user
 * users-table lookup can slot in later.
 */

const TRADE_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const API_PATH_PREFIX = "/trade-api/v2";

export interface KalshiCredentials {
  apiKeyId: string;
  privateKey: KeyObject;
}

let cachedCreds: KalshiCredentials | null | undefined;

export function isTradingConfigured(): boolean {
  return getKalshiCredentials() !== null;
}

/** Env-based credentials. userId param reserved for future per-user keys. */
export function getKalshiCredentials(_userId?: number): KalshiCredentials | null {
  if (cachedCreds !== undefined) return cachedCreds;

  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const pemB64 = process.env.KALSHI_PRIVATE_KEY_BASE64;
  const pemRaw = process.env.KALSHI_PRIVATE_KEY;

  if (!apiKeyId || (!pemB64 && !pemRaw)) {
    cachedCreds = null;
    return null;
  }

  try {
    const pem = pemB64
      ? Buffer.from(pemB64, "base64").toString("utf8")
      : pemRaw!.replace(/\\n/g, "\n");
    const privateKey = createPrivateKey(pem);
    cachedCreds = { apiKeyId, privateKey };
  } catch (err) {
    console.error("Kalshi trading: could not parse private key:", err);
    cachedCreds = null;
  }
  return cachedCreds;
}

// --- Server-time offset ---
// Kalshi rejects signatures whose timestamp drifts more than ~30s from its
// clock (header_timestamp_expired). Local clocks can drift (this machine has
// been observed >1 min behind with the Windows Time service disabled), so we
// derive an offset from Kalshi's own Date response header and sign with
// corrected time.
let timeOffsetMs = 0;
let offsetSyncedAt = 0;
const OFFSET_TTL_MS = 10 * 60 * 1000;

async function syncServerTime(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - offsetSyncedAt < OFFSET_TTL_MS) return;
  try {
    const res = await fetch(`${TRADE_API_BASE}/exchange/status`, { cache: "no-store" });
    const dateHeader = res.headers.get("date");
    if (dateHeader) {
      // Date header has second precision; +500ms centers the estimate
      timeOffsetMs = new Date(dateHeader).getTime() + 500 - Date.now();
      offsetSyncedAt = Date.now();
      if (Math.abs(timeOffsetMs) > 5_000) {
        console.warn(
          `[kalshiTrade] local clock is ${Math.round(timeOffsetMs / 1000)}s off Kalshi server time; compensating`,
        );
      }
    }
  } catch (err) {
    console.warn("[kalshiTrade] server time sync failed, using local clock:", err);
  }
}

/**
 * Sign a request per Kalshi's scheme: RSA-PSS-SHA256 over
 * `${timestampMs}${METHOD}${path}` where path includes /trade-api/v2
 * and excludes the query string. Timestamp is corrected by the measured
 * server-time offset.
 */
function signRequest(
  creds: KalshiCredentials,
  method: string,
  path: string,
): { timestamp: string; signature: string } {
  const timestamp = String(Date.now() + timeOffsetMs);
  const message = `${timestamp}${method}${path}`;
  const sign = createSign("sha256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    {
      key: creds.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );
  return { timestamp, signature };
}

export class KalshiTradeError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function tradeRequest<T>(
  method: "GET" | "POST" | "DELETE",
  pathWithQuery: string,
  body?: unknown,
): Promise<T> {
  const creds = getKalshiCredentials();
  if (!creds) {
    throw new KalshiTradeError(503, null, "Kalshi trading is not configured");
  }

  await syncServerTime();

  const attempt = async (): Promise<{ res: Response; json: unknown }> => {
    const pathOnly = pathWithQuery.split("?")[0];
    const { timestamp, signature } = signRequest(
      creds,
      method,
      `${API_PATH_PREFIX}${pathOnly}`,
    );

    const res = await fetch(`${TRADE_API_BASE}${pathWithQuery}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY": creds.apiKeyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body; keep raw text
      json = { raw: text };
    }
    return { res, json };
  };

  let { res, json } = await attempt();

  // A stale/newly-drifted clock shows up as header_timestamp_expired;
  // resync against the server clock once and retry.
  if (!res.ok && isTimestampError(json)) {
    await syncServerTime(true);
    ({ res, json } = await attempt());
  }

  if (!res.ok) {
    throw new KalshiTradeError(
      res.status,
      json,
      friendlyKalshiError(res.status, json),
    );
  }
  return json as T;
}

function isTimestampError(body: unknown): boolean {
  const code =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: string } }).error?.code
      : undefined;
  return code === "header_timestamp_expired";
}

function friendlyKalshiError(status: number, body: unknown): string {
  const code =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: string; message?: string } }).error
      : undefined;
  const detail = code?.message || code?.code || "";
  if (status === 401) return "Kalshi rejected the API credentials (401). Check the key ID and private key.";
  if (detail.toLowerCase().includes("insufficient"))
    return "Insufficient Kalshi balance for this order.";
  if (detail.toLowerCase().includes("closed") || detail.toLowerCase().includes("not open"))
    return "This market is closed for trading.";
  return detail ? `Kalshi error: ${detail}` : `Kalshi API error (${status})`;
}

// --- Endpoints ---

export interface KalshiBalance {
  balance: number; // cents
}

export async function getBalance(): Promise<KalshiBalance> {
  return tradeRequest<KalshiBalance>("GET", "/portfolio/balance");
}

/** Safety cap on contracts per order (shared by manual and automated paths). */
export function maxOrderContracts(): number {
  const v = parseInt(process.env.MAX_ORDER_CONTRACTS || "100", 10);
  return Number.isFinite(v) && v > 0 ? v : 100;
}

/**
 * A market position from GET /portfolio/positions, normalized.
 * `position` is signed: positive = YES contracts held, negative = NO.
 */
export interface KalshiPosition {
  ticker: string;
  position: number;
  marketExposureCents: number | null;
  realizedPnlCents: number | null;
  raw: unknown;
}

/** Numeric fields may arrive as integer cents or fixed-point strings. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface PositionsResponse {
  market_positions?: Array<Record<string, unknown>>;
  cursor?: string;
  [key: string]: unknown;
}

/**
 * All nonzero market positions on the account (cursor-paginated).
 * Used by the automation engine to reconcile its book against Kalshi's and
 * to avoid touching manually held tickers.
 */
export async function getPositions(): Promise<KalshiPosition[]> {
  const positions: KalshiPosition[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: "200" });
    if (cursor) qs.set("cursor", cursor);
    const res = await tradeRequest<PositionsResponse>(
      "GET",
      `/portfolio/positions?${qs.toString()}`,
    );

    for (const p of res.market_positions ?? []) {
      const ticker = typeof p.ticker === "string" ? p.ticker : null;
      // position may be `position` (classic int) or `position_fp` (fixed-point)
      const pos = toNumber(p.position) ?? toNumber(p.position_fp);
      if (!ticker || pos === null) continue;
      positions.push({
        ticker,
        position: Math.round(pos),
        marketExposureCents: toNumber(p.market_exposure),
        realizedPnlCents: toNumber(p.realized_pnl),
        raw: p,
      });
    }

    cursor = typeof res.cursor === "string" && res.cursor ? res.cursor : undefined;
    if (!cursor) break;
  }

  return positions.filter((p) => p.position !== 0);
}

export interface CreateOrderParams {
  ticker: string;
  clientOrderId: string;
  side: "yes" | "no";
  count: number;
  /** Worst acceptable price for the chosen side, in cents (ask + buffer). */
  maxPriceCents: number;
}

/** Normalized result of a V2 order placement. */
export interface PlacedOrder {
  orderId: string;
  clientOrderId: string;
  /** Contracts filled immediately (IOC cancels the rest). */
  fillCount: number;
  remainingCount: number;
  /** Average price paid for the chosen side (yes OR no), in cents. */
  avgFillPriceCents: number | null;
  /** Fee per contract in cents, when reported. */
  avgFeeCents: number | null;
  status: "executed" | "partial" | "canceled";
  raw: unknown;
}

interface CreateOrderV2Response {
  order_id: string;
  client_order_id: string;
  fill_count: string;
  remaining_count: string;
  average_fill_price?: string;
  average_fee_paid?: string;
  ts_ms?: number;
  [key: string]: unknown;
}

/**
 * Place an aggressive immediate-or-cancel buy — the V2 equivalent of a
 * market order with overspend protection.
 *
 * V2 uses a single YES-side book: `bid` buys YES; buying NO is expressed as
 * an `ask` (sell YES) at price 1 − noPrice. The IOC limit price IS the cost
 * cap — fills can't exceed it and the unfilled remainder cancels.
 */
export async function createOrder(params: CreateOrderParams): Promise<PlacedOrder> {
  const maxPrice = Math.min(99, Math.max(1, params.maxPriceCents)) / 100;
  const isYes = params.side === "yes";
  // YES-book limit price: aggressive = higher for bids, lower for asks
  const yesPrice = isYes ? maxPrice : 1 - maxPrice;

  const body = {
    ticker: params.ticker,
    client_order_id: params.clientOrderId,
    side: isYes ? "bid" : "ask",
    count: params.count.toFixed(2),
    price: yesPrice.toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  const res = await tradeRequest<CreateOrderV2Response>(
    "POST",
    "/portfolio/events/orders",
    body,
  );

  const fillCount = Math.round(parseFloat(res.fill_count || "0"));
  const remainingCount = Math.round(parseFloat(res.remaining_count || "0"));
  const avgYesFill = res.average_fill_price ? parseFloat(res.average_fill_price) : null;
  // Convert the YES-book fill price back to the side the user bought
  const avgSideFill =
    avgYesFill !== null ? (isYes ? avgYesFill : 1 - avgYesFill) : null;

  return {
    orderId: res.order_id,
    clientOrderId: res.client_order_id,
    fillCount,
    remainingCount,
    avgFillPriceCents: avgSideFill !== null ? Math.round(avgSideFill * 100) : null,
    avgFeeCents: res.average_fee_paid
      ? Math.round(parseFloat(res.average_fee_paid) * 100)
      : null,
    status: fillCount === 0 ? "canceled" : remainingCount > 0 ? "partial" : "executed",
    raw: res,
  };
}

export interface SellOrderParams {
  ticker: string;
  clientOrderId: string;
  /** The side currently HELD (what is being sold). */
  side: "yes" | "no";
  count: number;
  /** Worst acceptable sale proceeds per contract, in cents. */
  minProceedsCents: number;
}

/**
 * Close (part of) a held position with an aggressive IOC order.
 *
 * On the single YES-side book, selling held YES is an `ask` and selling held
 * NO is a `bid` (which nets against the NO position). The IOC limit price
 * guarantees proceeds per contract never drop below minProceedsCents; the
 * unfilled remainder cancels. avgFillPriceCents in the result is normalized
 * to proceeds per contract of the HELD side.
 */
export async function sellPosition(params: SellOrderParams): Promise<PlacedOrder> {
  const minProceeds = Math.min(99, Math.max(1, params.minProceedsCents)) / 100;
  const isYes = params.side === "yes";
  // Selling YES: ask at the floor price. Selling NO: bid for YES at the
  // ceiling price 1 − minProceeds (NO proceeds = 1 − yes price paid).
  const yesPrice = isYes ? minProceeds : 1 - minProceeds;

  const body = {
    ticker: params.ticker,
    client_order_id: params.clientOrderId,
    side: isYes ? "ask" : "bid",
    count: params.count.toFixed(2),
    price: yesPrice.toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  const res = await tradeRequest<CreateOrderV2Response>(
    "POST",
    "/portfolio/events/orders",
    body,
  );

  const fillCount = Math.round(parseFloat(res.fill_count || "0"));
  const remainingCount = Math.round(parseFloat(res.remaining_count || "0"));
  const avgYesFill = res.average_fill_price ? parseFloat(res.average_fill_price) : null;
  // Proceeds per contract for the held side
  const avgProceeds =
    avgYesFill !== null ? (isYes ? avgYesFill : 1 - avgYesFill) : null;

  return {
    orderId: res.order_id,
    clientOrderId: res.client_order_id,
    fillCount,
    remainingCount,
    avgFillPriceCents: avgProceeds !== null ? Math.round(avgProceeds * 100) : null,
    avgFeeCents: res.average_fee_paid
      ? Math.round(parseFloat(res.average_fee_paid) * 100)
      : null,
    status: fillCount === 0 ? "canceled" : remainingCount > 0 ? "partial" : "executed",
    raw: res,
  };
}
