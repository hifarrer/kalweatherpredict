/** Shared data shapes for the crypto backtest harness. */

/** Normalized Kalshi per-minute market candle (from /candlesticks). */
export interface BtKalshiCandle {
  /** End of the minute, ms epoch. */
  ts: number;
  /** Yes-side book at the close of the minute, dollars. 0 when absent. */
  yesBid: number;
  yesAsk: number;
  /** Contracts traded during the minute. */
  vol: number;
}

export interface BtMarket {
  ticker: string;
  strikeType: string;
  floor: number | null;
  cap: number | null;
  /** Settlement result. */
  result: "yes" | "no";
  /** Lifetime traded volume (liquidity filter). */
  volumeFp: number;
  candles: BtKalshiCandle[];
}

export interface BtEvent {
  eventTicker: string;
  seriesTicker: string;
  asset: string;
  title: string;
  /** Settlement time, ms epoch. */
  closeTs: number;
  /** Settlement value (parsed expiration_value). */
  actualValue: number | null;
  markets: BtMarket[];
}

/** Exchange spot candle (1m), reusing the app's shape. */
export interface BtSpotCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BtDvolPoint {
  ts: number;
  /** Annualized fraction (0.36 = 36%). */
  dvol: number;
}

export interface BtDataset {
  fetchedAt: string;
  days: number;
  events: BtEvent[];
  /** asset → ascending 1m candles covering the window. */
  spot: Record<string, BtSpotCandle[]>;
  /** asset → ascending hourly DVOL points. */
  dvol: Record<string, BtDvolPoint[]>;
}
