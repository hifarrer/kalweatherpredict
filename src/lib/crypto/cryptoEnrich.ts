import { EnrichedEvent } from "@/types";
import {
  computeEventVolume,
  computeEventVolume24h,
  computeEarliestClose,
  getEvent,
} from "@/lib/kalshi";
import { detectAsset } from "@/lib/crypto/assets";
import { computeMaxEdge } from "@/lib/enrich";
import { ASSET_MAP } from "@/lib/crypto/assets";
import { getRecentCandles, getSpot, SpotInfo } from "@/lib/crypto/spot";
import { computeRealizedVols, finalSigma, getImpliedVol } from "@/lib/crypto/vol";
import { predictCryptoEvent } from "@/lib/crypto/cryptoPredictor";
import { CryptoDbEventRow } from "@/lib/crypto/cryptoSync";
import { getCryptoVolCalibration } from "@/lib/crypto/cryptoVolCalibration";
import { DEFAULT_CRYPTO_PARAMS, RealizedVols } from "@/lib/crypto/params";

/**
 * Enrich crypto DB rows into the same EnrichedEvent shape the weather
 * pipeline produces, so computeSuggestedActions, the snapshot job, and the
 * shared UI components consume them unchanged.
 *
 * One spot + candles + DVOL fetch group per asset (not per event).
 */

export interface CryptoAssetContext {
  asset: string;
  spot: SpotInfo;
  /** Annualized realized vols per window (null when a window lacks data). */
  rvs: RealizedVols;
  /** Deribit DVOL as an annualized fraction, null when unavailable. */
  dvol: number | null;
}

export interface EnrichedCryptoBatch {
  events: EnrichedEvent[];
  /** Per-asset market context for the UI and AI prompts. */
  contexts: Record<string, CryptoAssetContext>;
}

export async function buildEnrichedCryptoEvents(
  rows: CryptoDbEventRow[],
): Promise<EnrichedCryptoBatch> {
  const assetCodes = [...new Set(rows.map((r) => r.asset).filter((a): a is string => !!a))];
  const calibration = await getCryptoVolCalibration();

  const contexts: Record<string, CryptoAssetContext> = {};
  await Promise.all(
    assetCodes.map(async (code) => {
      const asset = ASSET_MAP[code];
      if (!asset) return;
      try {
        const [spot, candles, dvol] = await Promise.all([
          getSpot(asset),
          getRecentCandles(asset, 1440),
          getImpliedVol(asset),
        ]);
        contexts[code] = {
          asset: code,
          spot,
          rvs: computeRealizedVols(candles, Date.now()),
          dvol,
        };
      } catch (err) {
        console.error(`[crypto/enrich] market data failed for ${code}:`, err);
      }
    }),
  );

  const enriched: EnrichedEvent[] = [];
  for (const row of rows) {
    const ctx = row.asset ? contexts[row.asset] : undefined;
    let prediction = null;

    if (ctx) {
      const closeMs = new Date(
        row.earliestClose || computeEarliestClose(row.event.markets),
      ).getTime();
      const tauHours = (closeMs - Date.now()) / 3_600_000;
      if (tauHours > 0) {
        const sigma = finalSigma(ctx.rvs, ctx.dvol, tauHours, calibration);
        if (sigma) {
          const usesIv = DEFAULT_CRYPTO_PARAMS.ivBlendBeta > 0 && sigma.implied !== null;
          prediction = predictCryptoEvent(row.event, ctx.spot, sigma.sigmaAnnual, {
            params: DEFAULT_CRYPTO_PARAMS,
            sigmaSource: `${usesIv ? "RV+DVOL" : "RV"}, cal ×${sigma.calibrationMult.toFixed(2)}`,
          });
        }
      }
    }

    enriched.push({
      event: row.event,
      cityCode: null,
      asset: row.asset,
      volume: computeEventVolume(row.event.markets),
      volume24h: computeEventVolume24h(row.event.markets),
      earliestClose: row.earliestClose || computeEarliestClose(row.event.markets),
      prediction,
      subcategory: "crypto_price",
      maxEdge: computeMaxEdge(prediction, row.event),
    });
  }

  return { events: enriched, contexts };
}

/**
 * Enrich one crypto event by ticker for the analyze/review routes: fresh
 * fetch from Kalshi (live book), asset derived from the series ticker.
 */
export async function enrichSingleCryptoEvent(
  eventTicker: string,
): Promise<{ enriched: EnrichedEvent; context: CryptoAssetContext | null } | null> {
  const event = await getEvent(eventTicker);
  if (!event) return null;
  const asset = detectAsset(event.series_ticker);
  if (!asset) return null;

  const { events, contexts } = await buildEnrichedCryptoEvents([
    { event, asset: asset.code, earliestClose: null },
  ]);
  if (events.length === 0) return null;
  return { enriched: events[0], context: contexts[asset.code] ?? null };
}
