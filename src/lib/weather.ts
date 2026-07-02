import { CityInfo, WeatherForecast, DailyForecast } from "@/types";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// In-memory forecast cache keyed by city code, TTL 10 minutes
const forecastCache: Record<string, { data: WeatherForecast; ts: number }> = {};
const FORECAST_TTL = 10 * 60 * 1000;

/**
 * Fetch a temperature forecast for a given city from Open-Meteo.
 * Returns daily max/min (Fahrenheit) for up to 16 days and hourly temps.
 */
export async function getForecast(city: CityInfo): Promise<WeatherForecast> {
  const now = Date.now();
  const cached = forecastCache[city.code];
  if (cached && now - cached.ts < FORECAST_TTL) {
    return cached.data;
  }

  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    daily:
      "temperature_2m_max,temperature_2m_min,rain_sum,precipitation_sum,snowfall_sum,precipitation_probability_max",
    hourly: "temperature_2m",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    timezone: "auto",
    forecast_days: "16",
  });

  const res = await fetch(`${OPEN_METEO_URL}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const dailyTimes: string[] = data.daily?.time || [];
  const dailyMax: number[] = data.daily?.temperature_2m_max || [];
  const dailyMin: number[] = data.daily?.temperature_2m_min || [];
  const dailyRain: (number | null)[] = data.daily?.rain_sum || [];
  const dailyPrecip: (number | null)[] = data.daily?.precipitation_sum || [];
  const dailySnow: (number | null)[] = data.daily?.snowfall_sum || [];
  const dailyPrecipProb: (number | null)[] = data.daily?.precipitation_probability_max || [];
  const hourlyTimes: string[] = data.hourly?.time || [];
  const hourlyTemps: number[] = data.hourly?.temperature_2m || [];

  const daily: DailyForecast[] = dailyTimes.map((date, i) => ({
    date,
    max: Math.round(dailyMax[i]),
    min: Math.round(dailyMin[i]),
    rain: dailyRain[i] ?? 0,
    precip: dailyPrecip[i] ?? 0,
    snowfall: dailySnow[i] ?? 0,
    precipProb: dailyPrecipProb[i] ?? 0,
  }));

  const todayHigh = daily.length > 0 ? daily[0].max : null;
  const todayLow = daily.length > 0 ? daily[0].min : null;

  const forecast: WeatherForecast = {
    city: city.code,
    todayHigh,
    todayLow,
    daily,
    hourlyTimes,
    hourlyTemps: hourlyTemps.map((t) => Math.round(t)),
  };

  forecastCache[city.code] = { data: forecast, ts: now };
  return forecast;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Batch-fetch forecasts for multiple city codes.
 * Uses limited concurrency (batches of 3) to avoid Open-Meteo rate limits.
 * Returns a map keyed by city code.
 */
export async function getForecastsForCities(
  cityCodes: string[],
  cityMap: Record<string, CityInfo>,
): Promise<Record<string, WeatherForecast>> {
  const results: Record<string, WeatherForecast> = {};
  const unique = [...new Set(cityCodes)];
  const BATCH_SIZE = 3;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (code) => {
        const city = cityMap[code];
        if (!city) return;
        try {
          results[code] = await getForecast(city);
        } catch (err) {
          console.error(`Failed to fetch forecast for ${code}:`, err);
        }
      }),
    );
    // Small delay between batches to avoid 429
    if (i + BATCH_SIZE < unique.length) {
      await sleep(500);
    }
  }

  return results;
}
