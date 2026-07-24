/**
 * Weather market series the model must never trade or be judged against:
 * hourly temperature series (settle on a single hour's reading the daily
 * model can't price) and series settled by The Weather Company rather than
 * the NWS climate report the forecasts target (KXHOLIDAY*, all KXRAIN
 * variants — the live bot went 0-for-5 on graded rain picks, −60.6¢ avg).
 *
 * Single source of truth shared by the live buy pass (autoTrade.ts) and the
 * backtest dataset fetcher (scripts/backtest/weather/fetch-weather.ts); kept
 * as a leaf module so CLI scripts can import it without dragging in the
 * Kalshi trading client.
 */
export const EXCLUDED_WEATHER_SERIES =
  /^(KXTEMP[A-Z]*H|KXHOLIDAYTMAX|KXHOLIDAYTMIN|KXRAIN[A-Z]*)-/;
