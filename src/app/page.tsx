"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { EnrichedEvent, WeatherForecast } from "@/types";
import { SortMode } from "@/lib/kalshi";
import Header from "@/components/Header";
import SortControls from "@/components/SortControls";
import SubcategoryFilter, {
  SubcategoryFilterValue,
} from "@/components/SubcategoryFilter";
import DateFilter from "@/components/DateFilter";
import EventCard from "@/components/EventCard";
import {
  DateFilterValue,
  bucketEventByDate,
} from "@/lib/eventDate";

export default function HomePage() {
  const [events, setEvents] = useState<EnrichedEvent[]>([]);
  const [forecasts, setForecasts] = useState<Record<string, WeatherForecast>>({});
  const [sort, setSort] = useState<SortMode>("opportunity");
  const [subcategory, setSubcategory] = useState<SubcategoryFilterValue>("all");
  const [dateFilter, setDateFilter] = useState<DateFilterValue>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      // Fetch events (predictions are computed server-side)
      const refreshParam = force ? "&refresh=1" : "";
      const eventsRes = await fetch(`/api/events?sort=${sort}${refreshParam}`, {
        cache: "no-store",
      });
      if (!eventsRes.ok) {
        const errData = await eventsRes.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to load events (${eventsRes.status})`);
      }
      const eventsData = await eventsRes.json();
      const newEvents: EnrichedEvent[] = eventsData.events || [];
      setEvents(newEvents);

      // Collect unique city codes from events
      const cityCodes = [...new Set(newEvents.map((e) => e.cityCode).filter(Boolean))] as string[];

      // Fetch weather forecasts if we have cities
      if (cityCodes.length > 0) {
        const weatherRes = await fetch(`/api/weather?cities=${cityCodes.join(",")}`);
        if (weatherRes.ok) {
          const weatherData = await weatherRes.json();
          setForecasts(weatherData.forecasts || {});
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [sort]);

  // Initial load + on sort change
  useEffect(() => {
    loadData(false);
  }, [loadData]);

  // Auto-refresh every 5 minutes (respects server-side TTL, no force)
  useEffect(() => {
    const interval = setInterval(() => loadData(false), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Count events per subcategory
  const subcategoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) {
      const cat = e.subcategory || "unknown";
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [events]);

  // Count events per date period (Today / Tomorrow / Future)
  const dateCounts = useMemo(() => {
    const counts: Record<DateFilterValue, number> = {
      all: events.length,
      today: 0,
      tomorrow: 0,
      future: 0,
    };
    for (const e of events) {
      const bucket = bucketEventByDate(e);
      if (bucket === "today" || bucket === "tomorrow" || bucket === "future") {
        counts[bucket] += 1;
      }
    }
    return counts;
  }, [events]);

  // Filter events by selected subcategory and date period
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (subcategory !== "all" && (e.subcategory || "unknown") !== subcategory) {
        return false;
      }
      if (dateFilter !== "all") {
        const bucket = bucketEventByDate(e);
        if (bucket !== dateFilter) return false;
      }
      return true;
    });
  }, [events, subcategory, dateFilter]);

  return (
    <div className="min-h-screen">
      <Header onRefresh={() => loadData(true)} loading={loading} />

      <main className="max-w-[1600px] mx-auto px-6 py-6">
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-kalshi-red/10 border border-kalshi-red/30">
            <p className="text-sm text-kalshi-red font-medium mb-1">Error loading data</p>
            <p className="text-xs text-kalshi-muted">{error}</p>
            <button
              onClick={() => loadData(true)}
              className="mt-2 text-xs text-kalshi-orange hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        <SortControls sort={sort} onSortChange={setSort} eventCount={filteredEvents.length} />

        {events.length > 0 && (
          <div className="mb-6 flex flex-col gap-3">
            <DateFilter
              value={dateFilter}
              onChange={setDateFilter}
              counts={dateCounts}
            />
            <SubcategoryFilter
              value={subcategory}
              onChange={setSubcategory}
              counts={subcategoryCounts}
            />
          </div>
        )}

        {loading && events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-10 h-10 border-3 border-kalshi-orange border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-kalshi-muted">Loading weather events from Kalshi...</p>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
            <p className="text-lg font-semibold text-kalshi-text">No events match your filters</p>
            <p className="text-sm text-kalshi-muted">
              Try selecting a different date period or category.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredEvents.map((e) => (
              <EventCard
                key={e.event.event_ticker}
                enriched={e}
                forecast={e.cityCode ? forecasts[e.cityCode] ?? null : null}
                onRefreshed={(updated) =>
                  setEvents((prev) =>
                    prev.map((p) =>
                      p.event.event_ticker === updated.event.event_ticker
                        ? updated
                        : p,
                    ),
                  )
                }
              />
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-kalshi-border mt-12">
        <div className="max-w-[1600px] mx-auto px-6 py-4 text-center">
          <p className="text-xs text-kalshi-muted">
            Data from Kalshi public API + Open-Meteo forecasts. AI analysis by Anthropic Claude.
          </p>
        </div>
      </footer>
    </div>
  );
}
