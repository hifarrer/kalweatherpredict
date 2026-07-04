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

export interface CreateOrderParams {
  ticker: string;
  clientOrderId: string;
  side: "yes" | "no";
  count: number;
  /** Worst-case total spend in cents (market-order overspend protection). */
  buyMaxCostCents: number;
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    client_order_id: string;
    ticker: string;
    status: string; // resting | executed | canceled | pending
    side: string;
    action: string;
    type: string;
    yes_price?: number;
    no_price?: number;
    taker_fill_count?: number;
    taker_fill_cost?: number;
    [key: string]: unknown;
  };
}

/** Place a market buy order. */
export async function createOrder(params: CreateOrderParams): Promise<KalshiOrderResponse> {
  return tradeRequest<KalshiOrderResponse>("POST", "/portfolio/orders", {
    ticker: params.ticker,
    client_order_id: params.clientOrderId,
    action: "buy",
    side: params.side,
    type: "market",
    count: params.count,
    buy_max_cost: params.buyMaxCostCents,
  });
}

export async function getOrder(orderId: string): Promise<KalshiOrderResponse> {
  return tradeRequest<KalshiOrderResponse>("GET", `/portfolio/orders/${encodeURIComponent(orderId)}`);
}
