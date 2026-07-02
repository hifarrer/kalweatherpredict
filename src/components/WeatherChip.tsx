import { WeatherForecast } from "@/types";
import { getForecastLinks } from "@/lib/forecastLinks";

interface WeatherChipProps {
  forecast: WeatherForecast | null;
  cityLabel: string | null;
  lat?: number;
  lon?: number;
  eventDate?: string | null;
}

export default function WeatherChip({
  forecast,
  cityLabel,
  lat,
  lon,
  eventDate,
}: WeatherChipProps) {
  if (!forecast || !cityLabel) {
    return null;
  }

  const todayHigh = forecast.todayHigh;
  const todayLow = forecast.todayLow;
  const today = forecast.daily[0];

  const links = lat != null && lon != null ? getForecastLinks(lat, lon, eventDate) : [];

  return (
    <div className="px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
          />
        </svg>
        <span className="text-kalshi-muted">{cityLabel}:</span>
        {todayHigh !== null && (
          <span className="text-kalshi-red font-medium">H {todayHigh}°</span>
        )}
        {todayLow !== null && (
          <span className="text-blue-400 font-medium">L {todayLow}°</span>
        )}
        {today?.rain !== undefined && today.rain > 0 && (
          <span className="text-cyan-400 font-medium">Rain {today.rain}"</span>
        )}
        {today?.snowfall !== undefined && today.snowfall > 0 && (
          <span className="text-white font-medium">Snow {today.snowfall}"</span>
        )}

        {/* Forecast source links */}
        {links.length > 0 && (
          <span className="inline-flex items-center gap-1 ml-auto">
            {links.map((src) => (
              <a
                key={src.id}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`View forecast on ${src.label}`}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 hover:bg-blue-500/20 hover:border-blue-400/40 text-[10px] font-bold text-kalshi-muted hover:text-blue-300 transition-colors"
              >
                {src.abbr}
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5m0 0v5m0-5L9 15" />
                </svg>
              </a>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
