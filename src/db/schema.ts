import {
  pgTable,
  text,
  jsonb,
  timestamp,
  bigserial,
  bigint,
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
export const events = pgTable(
  "events",
  {
    eventTicker: text("event_ticker").primaryKey(),
    seriesTicker: text("series_ticker").notNull(),
    title: text("title").notNull(),
    subTitle: text("sub_title"),
    category: text("category"),
    strikeDate: text("strike_date"),
    cityCode: text("city_code"),
    /** Which app section owns this event: "weather" | "crypto". */
    section: text("section").notNull().default("weather"),
    /** Crypto asset code ("BTC" | "ETH"), the crypto analog of city_code. */
    asset: text("asset"),
    status: text("status").notNull().default("open"), // "open" | "expired"
    data: jsonb("data").notNull(),
    earliestClose: text("earliest_close"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("events_section_status_idx").on(t.section, t.status)],
);

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
    fillCount: integer("fill_count"), // contracts actually filled (IOC may fill < count)
    avgFeeCents: integer("avg_fee_cents"), // Kalshi taker fee per contract, cents
    status: text("status").notNull().default("pending"), // pending | executed | canceled | failed
    /** Who placed the order: "manual" (UI) or "auto" (automation engine). */
    source: text("source").notNull().default("manual"),
    /** Which app section the order belongs to: "weather" | "crypto". */
    section: text("section").notNull().default("weather"),
    kalshiOrderId: text("kalshi_order_id"),
    /** Snapshot of the AI suggestion this order was placed from, if any. */
    suggestionId: bigint("suggestion_id", { mode: "number" }),
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
    section: text("section").notNull().default("weather"), // "weather" | "crypto"
    asset: text("asset"), // crypto asset code, null for weather
    metric: text("metric").notNull(),
    leadDays: integer("lead_days"),
    /** Hours until settlement at capture time — crypto's analog of lead_days. */
    tauHours: real("tau_hours"),
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
 * Point-in-time snapshots of AI trade suggestions, for accuracy tracking.
 *
 * Rows come from two sources: the hourly tracking pass persists every
 * suggestion the scorer produces ("scheduled"), and order placement persists
 * the exact suggestion the user acted on ("order", referenced by
 * orders.suggestion_id). Once the market settles, a background job fills the
 * grading columns in place — graded rows are the ML training dataset and are
 * never pruned.
 */
export const suggestions = pgTable(
  "suggestions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventTicker: text("event_ticker").notNull(),
    marketTicker: text("market_ticker").notNull(),
    side: text("side").notNull(), // "yes" | "no"
    kind: text("kind").notNull(), // "consensus" | "value"
    source: text("source").notNull(), // "scheduled" | "order"
    // Features mirroring SuggestedAction at the time of the snapshot
    price: real("price").notNull(),
    forecastProb: real("forecast_prob").notNull(),
    blendedProb: real("blended_prob").notNull(),
    winProb: real("win_prob").notNull(),
    marketProb: real("market_prob"),
    feePerContract: real("fee_per_contract").notNull(),
    evPerContract: real("ev_per_contract").notNull(),
    score: real("score").notNull(),
    volume24h: real("volume_24h"),
    // Event context
    cityCode: text("city_code"),
    section: text("section").notNull().default("weather"), // "weather" | "crypto"
    asset: text("asset"), // crypto asset code, null for weather
    metric: text("metric"),
    targetDate: text("target_date"),
    leadDays: integer("lead_days"),
    /** Hours until settlement at suggestion time — crypto's analog of lead_days. */
    tauHours: real("tau_hours"),
    aiVerdict: text("ai_verdict"), // keep | downgrade | veto
    aiConfidence: real("ai_confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Grading — filled by gradeSuggestions() once the market settles
    result: text("result"), // settlement result "yes" | "no"
    suggestedSideWon: boolean("suggested_side_won"),
    realizedEv: real("realized_ev"), // (won ? 1 : 0) − price − feePerContract
    gradedAt: timestamp("graded_at", { withTimezone: true }),
  },
  (t) => [
    index("suggestions_market_idx").on(t.marketTicker),
    index("suggestions_graded_idx").on(t.gradedAt),
    index("suggestions_created_idx").on(t.createdAt),
  ],
);

/**
 * Positions the automation engine has opened — the bot's own book.
 *
 * One row per automated buy that filled; the sell pass and settlement
 * reconciliation update it in place until it is closed. Budget accounting
 * derives "deployed" capital from rows with status open/closing.
 */
export const automationPositions = pgTable(
  "automation_positions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticker: text("ticker").notNull(),
    eventTicker: text("event_ticker").notNull(),
    side: text("side").notNull(), // "yes" | "no" — the side HELD
    count: integer("count").notNull(), // contracts currently held
    avgCostCents: integer("avg_cost_cents").notNull(), // per contract, ex-fee
    buyFeeCents: integer("buy_fee_cents"), // per contract
    openOrderId: bigint("open_order_id", { mode: "number" }), // orders.id of the buy
    suggestionId: bigint("suggestion_id", { mode: "number" }),
    status: text("status").notNull().default("open"), // open | closing | closed
    cityCode: text("city_code"),
    section: text("section").notNull().default("weather"), // "weather" | "crypto"
    asset: text("asset"), // crypto asset code, null for weather
    metric: text("metric"),
    targetDate: text("target_date"),
    // Exit — filled when the position closes
    exitReason: text("exit_reason"), // take_profit | stop_loss | settled | manual
    sellOrderId: bigint("sell_order_id", { mode: "number" }), // orders.id of the sell
    saleProceedsCents: integer("sale_proceeds_cents"), // total, ex-fee
    sellFeeCents: integer("sell_fee_cents"), // total sell-side fees
    realizedPnlCents: integer("realized_pnl_cents"), // net of all fees
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("auto_pos_status_idx").on(t.status),
    index("auto_pos_ticker_idx").on(t.ticker),
    index("auto_pos_section_status_idx").on(t.section, t.status),
  ],
);

/**
 * One row per automation run (external cron hit or manual "Run now").
 */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    trigger: text("trigger").notNull().default("cron"), // cron | manual
    status: text("status").notNull().default("running"), // running | ok | error | skipped
    section: text("section").notNull().default("weather"), // "weather" | "crypto"
    balanceCents: integer("balance_cents"),
    deployedCents: integer("deployed_cents"),
    candidates: integer("candidates"),
    buys: integer("buys"),
    sells: integer("sells"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("auto_runs_started_idx").on(t.startedAt)],
);

/**
 * Every decision an automation run makes — buys, sells, and skips with a
 * human-readable reason — so the activity log can show WHY the bot acted.
 */
export const automationActions = pgTable(
  "automation_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    kind: text("kind").notNull(), // buy | sell | close_settled | skip | error | info
    ticker: text("ticker"),
    eventTicker: text("event_ticker"),
    side: text("side"),
    count: integer("count"),
    priceCents: integer("price_cents"),
    reason: text("reason").notNull(),
    orderId: bigint("order_id", { mode: "number" }),
    positionId: bigint("position_id", { mode: "number" }),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("auto_actions_run_idx").on(t.runId)],
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
    section: text("section").notNull().default("weather"), // "weather" | "crypto"
    asset: text("asset"), // crypto asset code, null for weather
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
