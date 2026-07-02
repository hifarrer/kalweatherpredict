import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

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
 * Key/value store for sync metadata (last sync time, weather series list, etc.)
 */
export const syncMeta = pgTable("sync_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
