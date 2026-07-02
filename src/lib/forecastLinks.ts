export interface ForecastSource {
  id: string;
  label: string; // full name for tooltip
  abbr: string; // short badge text: "NWS", "TWC", "WU", "OM"
  url: string;
}

/**
 * Generate deep-link URLs to multiple weather forecast sites for a given
 * location (and optionally a specific date).
 *
 * All sites support lat/lon coordinates. Open-Meteo additionally supports
 * date-specific deep-linking; the others show multi-day extended forecasts
 * starting from today so the user can scroll to the event date.
 */
export function getForecastLinks(
  lat: number,
  lon: number,
  date?: string | null,
): ForecastSource[] {
  const links: ForecastSource[] = [
    {
      id: "nws",
      label: "National Weather Service",
      abbr: "NWS",
      url: `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`,
    },
    {
      id: "twc",
      label: "Weather.com (The Weather Channel)",
      abbr: "TWC",
      url: `https://weather.com/weather/today/l/${lat4(lat)},${lat4(lon)}`,
    },
    {
      id: "wu",
      label: "Weather Underground",
      abbr: "WU",
      url: `https://www.wunderground.com/weather/${lat4(lat)},${lat4(lon)}`,
    },
    {
      id: "openmeteo",
      label: "Open-Meteo (forecast data source)",
      abbr: "OM",
      url: buildOpenMeteoUrl(lat, lon, date),
    },
  ];

  return links;
}

/**
 * Build the Open-Meteo documentation URL with date-specific deep-linking.
 * When a date is provided, uses start_date/end_date to scope to that single day.
 */
function buildOpenMeteoUrl(lat: number, lon: number, date?: string | null): string {
  const base = "https://open-meteo.com/en/docs";
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    timezone: "auto",
  });

  if (date) {
    params.set("start_date", date);
    params.set("end_date", date);
  }

  return `${base}?${params.toString()}`;
}

/** Round to 4 decimal places and stringify (avoids floating-point noise in URLs). */
function lat4(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}
