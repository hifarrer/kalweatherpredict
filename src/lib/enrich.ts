import {
  computeEventVolume,
  computeEventVolume24h,
  computeEarliestClose,
} from "@/lib/kalshi";
import { CITY_MAP, detectMultiCity } from "@/lib/cities";
import { getForecastsForCities } from "@/lib/weather";
import {
  predictEvent,
  predictMultiCityEvent,
  computeOpportunityScore,
  detectMetric,
} from "@/lib/predictor";
import { EnrichedEvent, KalshiEvent, PredictionResult } from "@/types";
import { DbEventRow } from "@/lib/sync";
import { getSigmaCalibration } from "@/lib/calibrationStore";

/** Minimum 24h market volume for a market's edge to count at event level. */
const EDGE_MIN_VOLUME = 100;

/**
 * Largest absolute forecast-vs-market probability gap among an event's
 * liquid markets. Drives the "edge" sort.
 */
function computeMaxEdge(
  prediction: PredictionResult | null,
  event: KalshiEvent,
): number | undefined {
  if (!prediction?.marketLikelihoods || !event.markets) return undefined;

  const volByTicker = new Map(
    event.markets.map((m) => [m.ticker, parseFloat(m.volume_24h_fp || "0")]),
  );

  let maxEdge = 0;
  let found = false;
  for (const ml of prediction.marketLikelihoods) {
    if (ml.edge === undefined) continue;
    if ((volByTicker.get(ml.ticker) ?? 0) < EDGE_MIN_VOLUME) continue;
    found = true;
    if (Math.abs(ml.edge) > Math.abs(maxEdge)) maxEdge = ml.edge;
  }
  return found ? maxEdge : undefined;
}

/**
 * Enrich a batch of DB event rows: detect cities, fetch forecasts, and
 * compute predictions + opportunity scores.
 *
 * Shared by the events API route and the prediction snapshot job so both
 * produce identical predictions.
 */
export async function buildEnrichedEvents(rows: DbEventRow[]): Promise<EnrichedEvent[]> {
  // Collect city codes for the forecast fetch
  const cityCodesNeeded: string[] = [];
  for (const row of rows) {
    const multi = detectMultiCity(row.event);
    if (multi) {
      for (const c of multi.cities) {
        if (!cityCodesNeeded.includes(c.code)) cityCodesNeeded.push(c.code);
      }
    } else if (row.cityCode && !cityCodesNeeded.includes(row.cityCode)) {
      cityCodesNeeded.push(row.cityCode);
    }
  }

  const [forecasts, calibration] = await Promise.all([
    getForecastsForCities(cityCodesNeeded, CITY_MAP),
    getSigmaCalibration(),
  ]);

  return rows.map(({ event: e, cityCode, earliestClose }) => {
    const multi = detectMultiCity(e);
    const prediction = multi
      ? predictMultiCityEvent(e, forecasts, multi.marketCities, calibration)
      : predictEvent(
          e,
          cityCode ? forecasts[cityCode] ?? null : null,
          cityCode ? CITY_MAP[cityCode]?.timezone : undefined,
          calibration,
        );

    return {
      event: e,
      cityCode,
      volume: computeEventVolume(e.markets),
      volume24h: computeEventVolume24h(e.markets),
      earliestClose: earliestClose || computeEarliestClose(e.markets),
      prediction,
      opportunityScore: computeOpportunityScore(e, prediction),
      subcategory: detectMetric(e),
      maxEdge: computeMaxEdge(prediction, e),
    };
  });
}

/**
 * Enrich a single live-fetched Kalshi event (used by the per-card refresh
 * route). The caller supplies the detected cityCode.
 */
export async function enrichSingleEvent(
  event: KalshiEvent,
  cityCode: string | null,
): Promise<EnrichedEvent> {
  const [enriched] = await buildEnrichedEvents([
    { event, cityCode, earliestClose: null },
  ]);
  return enriched;
}
