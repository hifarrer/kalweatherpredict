# Same-day "certain loser" diagnosis (2026-07-16)

`npm run diagnose:same-day -- --nws` classified every graded weather suggestion
with `win_prob >= 0.99` that lost (113 rows). Findings, in order of impact:

## 1. Houston settles on Hobby (KHOU), the app was reading Intercontinental (KIAH)

The settlement source for `KXHIGHTHOU` / `KXLOWTHOU` / `KXRAINHOUM` is the NWS
CLI report `issuedby=HOU` — **William P. Hobby Airport (KHOU)**. `CITY_MAP.HOU`
pointed at **KIAH** (Bush Intercontinental), ~20 mi inland and reliably cooler
overnight. Every same-day Houston prediction (obs blending, forced outcomes,
station bias correction, forecast grid coords) used the wrong airport.

Smoking gun from raw NWS observations vs Kalshi settlement:

- `KXLOWTHOU-26JUL10-B77.5`: settled low **77**, but KIAH's civil-day obs
  minimum was **75.2** — an official low *above* the station's raw minimum is
  impossible for the same station.
- Control case `KXLOWTATL-26JUL09` (correct station KATL): settled 76 vs obs
  min 78.1 — the normal direction (CLI uses the continuous sensor minimum,
  which dips between 5-minute reports).

HOU accounts for 57 of the 113 certain-losers (29 low + 27 high + 1 other).

## 2. NYC block = legacy hourly series, already excluded

All 45 NYC rows are `KXTEMPNYCH-*` (hourly) tickers created 07-05/07-06,
before the 07-09 hourly-series exclusion. They settle on **The Weather
Company** data, not NWS CLI (as do `KXHOLIDAYTMAX/TMIN`, `KXRAIN`,
`KXTEMP*H`). No new fix needed, but these rows must be excluded from
calibration, stats, and the weather backtest dataset.

## 3. Forced outcomes fired from model-assimilated obs (ATL case)

`observationForcedOutcome` accepts `source === "model"` observations with a
3°F margin; Open-Meteo's assimilated past-hours ran cold enough to "force" a
NO that settled YES. Forcing is only safe from official station obs, where the
inequality is one-sided (CLI min ≤ obs min, CLI max ≥ obs max).

## 4. Midnight rollover (H1) is real, but a separate leak

`suggestions.target_date <> settlements.target_date` on **619 graded
suggestions — 617 of them lost (99.7%)**. These mostly carried win_prob below
0.99, so they weren't in this cohort, but they poison calibration and stats:
with date-matching enforced, lead-0 `temperature_low` sigma drops 2.71 → 1.55.
Root cause confirmed in `resolveForecastIndex` (predictor.ts): after local
midnight, a still-open yesterday event matches nothing in `forecast.daily[]`
and the `close_time` candidate (or index-0 fallback) lands on the *new* day.

## 5. Sigma calibration is outlier-inflated

| metric | lead | sigma (current) | sigma (date-matched) | MAD sigma | n |
| --- | --- | --- | --- | --- | --- |
| temperature_high | 0 | 6.43 | 5.64 | **2.97** | 420 |
| temperature_high | 1 | 4.00 | 4.00 | 2.97 | 245 |
| temperature_low | 0 | 2.71 | 1.55 | 1.48 | 245 |
| temperature_low | 1 | 2.54 | 2.54 | 2.97 | 226 |

`stddev_samp` is dominated by wrong-station (HOU) and wrong-day (rollover)
blunders; the MAD-based sigma is the robust replacement (Phase D).

## 6. Classification detail

- 112/113 "decided path" (model pinned with a market price present — obs
  blending / forced outcomes, dominated by items 1–3 above); 1/113 other.
- 0/113 were the H4 `market_prob IS NULL` blend hole — but the hole is real
  code (extreme prices return `null` and hand the model 100% weight) and gets
  closed anyway as belt-and-braces.
- Pins happen all day (49/59 markets were pinned from their very first
  snapshot), not in a midnight spike — consistent with wrong-station obs, not
  rollover, driving this cohort.

## Fix list shipped from this diagnosis

1. `cities.ts`: HOU station → KHOU (Hobby); settlement-source guardrail
   (compare `settlement_sources[].url` `issuedby=` code against the configured
   station) so a station mismatch can never go unnoticed again.
2. `predictor.ts`: stale-event sentinel in `resolveForecastIndex` (no
   prediction for events whose date precedes the forecast window).
3. `suggest.ts`: clamp extreme market prices in `blendableMarketProb` instead
   of returning null; sanity guard that drops `decided` when the model is
   >50 points from a live market.
4. `observed.ts`: forced outcomes require station-sourced observations.
5. `weather.ts`: fetch station obs with `start=<local midnight>` (not
   `limit=100`, which covers only ~8h at 5-minute stations and can miss the
   morning minimum); drop QC-flagged readings.
6. Calibration/stats/backtest: exclude Weather-Company-settled series
   (`KXTEMP*H`, `KXHOLIDAY*`, `KXRAIN` non-M) and target-date-mismatched rows.
