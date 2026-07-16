import { CityInfo, WeatherForecast, DailyForecast, ModelDailyValues } from "@/types";
import { forecastCoords } from "@/lib/cities";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// In-memory forecast cache keyed by city code, TTL 10 minutes
const forecastCache: Record<string, { data: WeatherForecast; ts: number }> = {};
const FORECAST_TTL = 10 * 60 * 1000;

/**
 * Independent forecast models blended into the ensemble. best_match is also
 * requested (it powers the hourly series and precip probability) but is
 * excluded here because in the US it resolves to GFS — counting it would
 * silently double-weight GFS in the median/spread.
 */
export const ENSEMBLE_MODELS = [
  "ecmwf_ifs025",
  "gfs_seamless",
  "ncep_nbm_conus",
  "gfs_hrrr",
] as const;

export const MODEL_LABELS: Record<string, string> = {
  ecmwf_ifs025: "ECMWF",
  gfs_seamless: "GFS",
  ncep_nbm_conus: "NBM",
  gfs_hrrr: "HRRR",
};

const REQUESTED_MODELS = ["best_match", ...ENSEMBLE_MODELS];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function nonNull(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
}

/**
 * Read a per-model daily series from the Open-Meteo response. With multiple
 * models requested, every variable is suffixed with the model name
 * (e.g. temperature_2m_max_ecmwf_ifs025).
 */
function modelSeries(
  block: Record<string, unknown> | undefined,
  variable: string,
  model: string,
): (number | null)[] {
  const arr = block?.[`${variable}_${model}`];
  return Array.isArray(arr) ? (arr as (number | null)[]) : [];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Today's official observations at an NWS station (running max/min in °F,
 * for the station's local calendar day). Kalshi settles on the NWS climate
 * report, so these are authoritative over model-assimilated estimates —
 * on extreme days the model grid can run several °F away from the station.
 * Returns null on any failure; callers fall back to Open-Meteo past hours.
 */
async function getStationObsToday(
  stationId: string,
  timezone: string,
): Promise<{ max: number | null; min: number | null; count: number; earliest: string | null } | null> {
  try {
    // Ask for everything since local midnight. The old bare limit=100 covered
    // only ~8 hours at 5-minute ASOS stations, so evening queries silently
    // dropped the morning minimum — fatal for low-temperature markets.
    const start = new Date(Date.now() - 27 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
    const res = await fetch(
      `https://api.weather.gov/stations/${stationId}/observations?start=${encodeURIComponent(start)}&limit=500`,
      {
        headers: {
          "User-Agent": "kalshi-weather-dashboard (personal use)",
          Accept: "application/geo+json",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const data = await res.json();

    const dayFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const today = dayFmt.format(new Date());

    let max: number | null = null;
    let min: number | null = null;
    let count = 0;
    let earliest: string | null = null;
    for (const f of data.features ?? []) {
      const ts = f.properties?.timestamp;
      const c = f.properties?.temperature?.value;
      if (ts == null || c == null) continue;
      if (dayFmt.format(new Date(ts)) !== today) continue;
      // Drop readings NWS flagged as rejected (X) or questioned (Q).
      // "Z" (preliminary, QC not yet run) must pass — fresh obs carry it.
      const qc = f.properties?.temperature?.qualityControl;
      if (typeof qc === "string" && /:(X|Q)$/.test(qc)) continue;
      const tempF = (c * 9) / 5 + 32;
      count++;
      if (max === null || tempF > max) max = tempF;
      if (min === null || tempF < min) min = tempF;
      if (earliest === null || ts < earliest) earliest = ts;
    }

    return count > 0
      ? {
          max: max !== null ? round1(max) : null,
          min: min !== null ? round1(min) : null,
          count,
          earliest,
        }
      : null;
  } catch (err) {
    console.error(`[weather] NWS obs fetch failed for ${stationId}:`, err);
    return null;
  }
}

/**
 * Fetch a multi-model forecast for a given city from Open-Meteo.
 *
 * Requests ECMWF, GFS, NBM, and HRRR alongside best_match; the daily point
 * estimate is the cross-model median and the per-day model disagreement
 * (sample stddev) is exposed as `spread` for uncertainty modeling.
 * Hourly covers the past 24h (feeds same-day observation blending) plus the
 * next 72h. Units: Fahrenheit / inches, city-local timezone.
 */
export async function getForecast(city: CityInfo): Promise<WeatherForecast> {
  const now = Date.now();
  const cached = forecastCache[city.code];
  if (cached && now - cached.ts < FORECAST_TTL) {
    return cached.data;
  }

  const coords = forecastCoords(city);
  const params = new URLSearchParams({
    latitude: String(coords.lat),
    longitude: String(coords.lon),
    daily:
      "temperature_2m_max,temperature_2m_min,rain_sum,precipitation_sum,snowfall_sum,precipitation_probability_max",
    hourly: "temperature_2m,precipitation",
    models: REQUESTED_MODELS.join(","),
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    timezone: "auto",
    forecast_days: "16",
    past_hours: "24",
    forecast_hours: "72",
  });

  // Fetch model forecast and (when we know the settlement station) today's
  // official NWS observations in parallel.
  const [res, stationObs] = await Promise.all([
    fetch(`${OPEN_METEO_URL}?${params.toString()}`, { cache: "no-store" }),
    city.station
      ? getStationObsToday(city.station.id, city.timezone)
      : Promise.resolve(null),
  ]);
  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const dailyBlock = data.daily as Record<string, unknown> | undefined;
  const hourlyBlock = data.hourly as Record<string, unknown> | undefined;
  const dailyTimes: string[] = (dailyBlock?.time as string[]) || [];
  const utcOffsetSeconds: number = data.utc_offset_seconds ?? 0;

  // Per-model daily series
  const perModel: Record<string, {
    max: (number | null)[];
    min: (number | null)[];
    precip: (number | null)[];
    snow: (number | null)[];
  }> = {};
  for (const m of ENSEMBLE_MODELS) {
    perModel[m] = {
      max: modelSeries(dailyBlock, "temperature_2m_max", m),
      min: modelSeries(dailyBlock, "temperature_2m_min", m),
      precip: modelSeries(dailyBlock, "precipitation_sum", m),
      snow: modelSeries(dailyBlock, "snowfall_sum", m),
    };
  }
  const bestRain = modelSeries(dailyBlock, "rain_sum", "best_match");
  const bestPrecip = modelSeries(dailyBlock, "precipitation_sum", "best_match");
  const bestSnow = modelSeries(dailyBlock, "snowfall_sum", "best_match");
  const bestMax = modelSeries(dailyBlock, "temperature_2m_max", "best_match");
  const bestMin = modelSeries(dailyBlock, "temperature_2m_min", "best_match");
  // Precip probability is only produced by some models; take the first
  // requested model that has it.
  let precipProbSeries: (number | null)[] = [];
  for (const m of REQUESTED_MODELS) {
    const s = modelSeries(dailyBlock, "precipitation_probability_max", m);
    if (nonNull(s).length > 0) {
      precipProbSeries = s;
      break;
    }
  }

  const daily: DailyForecast[] = dailyTimes.map((date, i) => {
    const byModel: Record<string, ModelDailyValues> = {};
    for (const m of ENSEMBLE_MODELS) {
      byModel[m] = {
        max: perModel[m].max[i] ?? null,
        min: perModel[m].min[i] ?? null,
        precip: perModel[m].precip[i] ?? null,
        snow: perModel[m].snow[i] ?? null,
      };
    }

    const maxes = nonNull(ENSEMBLE_MODELS.map((m) => byModel[m].max));
    const mins = nonNull(ENSEMBLE_MODELS.map((m) => byModel[m].min));
    const precips = nonNull(ENSEMBLE_MODELS.map((m) => byModel[m].precip));
    const snows = nonNull(ENSEMBLE_MODELS.map((m) => byModel[m].snow));

    // Median across ensemble members; fall back to best_match when no
    // ensemble member covers this day (e.g. day 11+ for some variables).
    const medMax = median(maxes) ?? bestMax[i] ?? 0;
    const medMin = median(mins) ?? bestMin[i] ?? 0;
    const medPrecip = median(precips) ?? bestPrecip[i] ?? 0;
    const medSnow = median(snows) ?? bestSnow[i] ?? 0;

    return {
      date,
      max: Math.round(medMax),
      min: Math.round(medMin),
      rain: round1(bestRain[i] ?? medPrecip),
      precip: round1(medPrecip),
      snowfall: round1(medSnow),
      precipProb: precipProbSeries[i] ?? 0,
      byModel,
      spread: {
        max: round1(sampleStdDev(maxes)),
        min: round1(sampleStdDev(mins)),
        precip: round1(sampleStdDev(precips)),
        snow: round1(sampleStdDev(snows)),
      },
    };
  });

  // Hourly: best_match series, past 24h + next 72h, local ISO timestamps
  const hourlyTimes: string[] = (hourlyBlock?.time as string[]) || [];
  const hourlyTempsRaw = modelSeries(hourlyBlock, "temperature_2m", "best_match");
  const hourlyPrecipRaw = modelSeries(hourlyBlock, "precipitation", "best_match");
  const hourlyTemps = hourlyTimes.map((_, i) => Math.round(hourlyTempsRaw[i] ?? 0));
  const hourlyPrecip = hourlyTimes.map((_, i) => round1(hourlyPrecipRaw[i] ?? 0));

  // Split off the hours that have already elapsed in the city's local time.
  // Hourly timestamps are local ISO ("YYYY-MM-DDTHH:MM"), so build a
  // comparable "local now" string from the UTC offset.
  const localNowIso = new Date(now + utcOffsetSeconds * 1000).toISOString().slice(0, 16);
  const pastHours: { times: string[]; temps: number[]; precip: number[] } = {
    times: [],
    temps: [],
    precip: [],
  };
  hourlyTimes.forEach((t, i) => {
    if (t <= localNowIso) {
      pastHours.times.push(t);
      pastHours.temps.push(hourlyTemps[i]);
      pastHours.precip.push(hourlyPrecip[i]);
    }
  });

  const todayHigh = daily.length > 0 ? daily[0].max : null;
  const todayLow = daily.length > 0 ? daily[0].min : null;

  const forecast: WeatherForecast = {
    city: city.code,
    todayHigh,
    todayLow,
    daily,
    hourlyTimes,
    hourlyTemps,
    hourlyPrecip,
    pastHours,
    stationObs: stationObs ?? undefined,
    modelsUsed: [...ENSEMBLE_MODELS],
    stationId: city.station?.id,
    utcOffsetSeconds,
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
