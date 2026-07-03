import { EnrichedEvent } from "@/types";
import { CITY_MAP } from "@/lib/cities";
import { parseDateFromTitle, utcToLocalDateString } from "@/lib/predictor";

/** Selectable date-period filter values for the dashboard. */
export type DateFilterValue = "all" | "today" | "tomorrow" | "future";

/** Internal bucketing of an event's date, including non-selectable buckets. */
export type DateBucket = "today" | "tomorrow" | "future" | "other";

/**
 * Derive the local calendar date (YYYY-MM-DD) an event settles on.
 * Mirrors the logic in EventCard so filtering and display always agree.
 * Uses the city's timezone when converting UTC timestamps so that a
 * strike_date like "2026-07-03T03:59:00Z" maps to the correct local date.
 */
export function getEventLocalDate(enriched: EnrichedEvent): string | null {
  const { event, cityCode } = enriched;
  const city = cityCode ? CITY_MAP[cityCode] : null;
  return (
    parseDateFromTitle(event.title) ??
    (event.strike_date
      ? utcToLocalDateString(event.strike_date, city?.timezone)
      : null)
  );
}

/** A date formatted as YYYY-MM-DD in the viewer's local timezone. */
export function localDateString(date: Date): string {
  // en-CA locale yields YYYY-MM-DD, which compares chronologically.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Today's date in the viewer's local timezone, as YYYY-MM-DD. */
export function todayLocalDate(now = new Date()): string {
  return localDateString(now);
}

/** A date offset by `days` from the viewer's today, as YYYY-MM-DD. */
export function offsetLocalDate(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

/**
 * Bucket an event into a date period relative to the viewer's today.
 * "other" covers past dates and events with no resolvable date; these
 * only appear under the "All" filter.
 */
export function bucketEventByDate(
  enriched: EnrichedEvent,
  now = new Date(),
): DateBucket {
  const d = getEventLocalDate(enriched);
  if (!d) return "other";
  if (d < todayLocalDate(now)) return "other"; // past
  if (d === todayLocalDate(now)) return "today";
  if (d === offsetLocalDate(1, now)) return "tomorrow";
  return "future";
}
