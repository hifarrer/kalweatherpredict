import {
  pgTable,
  text,
  jsonb,
  timestamp,
  bigserial,
  integer,
  real,
  boolean,
  index,
} from "drizzle-orm/pg-core";

/**
 * Cached Kalshi weather events.
 *
 * The `data` jsonb column stores the full KalshiEvent (including nested markets)
 * so the dashboard can render entirely from the DB without hitting the Kalshi API.
 */
export const events = pgTable("events", {
  eventTicker: text("event_ticker").primaryKey(),
  seriesTicker: text("series_ticker").notNull(),
  title: text("title").notNull(),
  subTitle: text("sub_title"),
  category: text("category"),
  strikeDate: text("strike_date"),
  cityCode: text("city_code"),
  status: text("status").notNull().default("open"), // "open" | "expired"
  data: jsonb("data").notNull(),
  earliestClose: text("earliest_close"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Application users.
 *
 * Single admin user today (seeded from ADMIN_EMAIL/ADMIN_PASSWORD on boot);
 * the table exists so multi-user support can be added without a schema
 * rework. The kalshi_* columns are reserved for future per-user trading
 * credentials (currently trading keys come from env vars).
 */
export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("admin"),
  kalshiApiKeyId: text("kalshi_api_key_id"),
  kalshiPrivateKeyEnc: text("kalshi_private_key_enc"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Local audit log of orders placed through the app.
 *
 * A row is inserted before the Kalshi API call (client_order_id is generated
 * server-side for idempotency) and updated with Kalshi's response after.
 */
export const orders = pgTable(
  "orders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    clientOrderId: text("client_order_id").notNull().unique(),
    userId: integer("user_id"),
    ticker: text("ticker").notNull(),
    eventTicker: text("event_ticker").notNull(),
    side: text("side").notNull(), // "yes" | "no"
    action: text("action").notNull().default("buy"),
    type: text("type").notNull().default("market"),
    count: integer("count").notNull(),
    maxCostCents: integer("max_cost_cents"),
    avgFillPriceCents: integer("avg_fill_price_cents"),
    status: text("status").notNull().default("pending"), // pending | executed | canceled | failed
    kalshiOrderId: text("kalshi_order_id"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("orders_event_idx").on(t.eventTicker)],
);

/**
 * Key/value store for sync metadata (last sync time, weather series list, etc.)
 */
export const syncMeta = pgTable("sync_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Point-in-time prediction snapshots for accuracy tracking.
 *
 * Written hourly (plus a final snapshot shortly before each market closes)
 * so settled markets can later be compared against what the model predicted.
 */
export const predictionSnapshots = pgTable(
  "prediction_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventTicker: text("event_ticker").notNull(),
    marketTicker: text("market_ticker").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    targetDate: text("target_date"),
    cityCode: text("city_code"),
    metric: text("metric").notNull(),
    leadDays: integer("lead_days"),
    forecastValue: real("forecast_value"),
    sigma: real("sigma"),
    modelSpread: real("model_spread"),
    predictedProb: real("predicted_prob").notNull(),
    marketProb: real("market_prob"),
    isFinal: boolean("is_final").notNull().default(false),
  },
  (t) => [
    index("snap_market_captured_idx").on(t.marketTicker, t.capturedAt),
    index("snap_target_date_idx").on(t.targetDate),
  ],
);

/**
 * Settled market outcomes fetched from Kalshi after events close.
 * actual_value is the parsed expiration_value (the observed weather value,
 * e.g. the official high temperature) when numeric.
 */
export const settlements = pgTable(
  "settlements",
  {
    marketTicker: text("market_ticker").primaryKey(),
    eventTicker: text("event_ticker").notNull(),
    cityCode: text("city_code"),
    metric: text("metric"),
    targetDate: text("target_date"),
    result: text("result").notNull(), // "yes" | "no"
    actualValue: real("actual_value"),
    strikeType: text("strike_type"),
    floorStrike: real("floor_strike"),
    capStrike: real("cap_strike"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("settlements_event_idx").on(t.eventTicker)],
);
