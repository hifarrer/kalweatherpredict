import { WeatherForecast } from "@/types";

interface WeatherChipProps {
  forecast: WeatherForecast | null;
  cityLabel: string | null;
}

export default function WeatherChip({ forecast, cityLabel }: WeatherChipProps) {
  if (!forecast || !cityLabel) {
    return null;
  }

  const todayHigh = forecast.todayHigh;
  const todayLow = forecast.todayLow;
  const today = forecast.daily[0];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs">
      <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
    </div>
  );
}
