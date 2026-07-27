# Weather strategy backtest

Generated 2026-07-27T16:40:09.913Z from dataset fetched 2026-07-27T16:39:55.964Z.

Dataset: 42052 graded weather suggestions; 40253 usable after excluding twc_series (813), target_mismatch (986).

## Walk-forward folds (expanding origin)

| fold | train | validation |
| --- | --- | --- |
| 1 | 2026-07-05 → <2026-07-16 (25756 rows) | 2026-07-16 → 2026-07-19 (5388 rows) |
| 2 | 2026-07-05 → <2026-07-20 (31144 rows) | 2026-07-20 → 2026-07-23 (5376 rows) |
| 3 | 2026-07-05 → <2026-07-24 (36520 rows) | 2026-07-24 → 2026-07-26 (3733 rows) |

## Stage 1 — blend-weight Brier sweep (final snapshots, bug cohort excluded)

| model weight w | Brier |
| --- | --- |
| 0 | 0.0047 |
| 0.1 | 0.0066 |
| 0.2 | 0.0111 |
| 0.3 | 0.0185 |
| 0.4 | 0.0286 |
| 0.5 | 0.0416 |
| 0.65 | 0.0662 |
| 0.8 | 0.0970 |
| 1 | 0.1479 |

**Read stage 1 with care:** final snapshots are captured minutes before close, when the book has already converged on the outcome — so this sweep flatters the market and would pick w≈0. Trading happens hours earlier; the stage-2 simulation (which scores at suggestion time, fee- and price-aware) is the authority on weights.

## Stage 2 — walk-forward grid (16200 combos, 26 survived every fold, 0 λ-calibrated survivors)

| rank | w/wObs | filters | exits | pooled validation | worst fold | hold floor |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.1/0.5 | ev≥0.12 px 40-99 gap≤0.2 lead01 high_low h≥15 | tp30 | 43 trades, 72% win, $44.20 (ROI 10.6%) | $5.84 | $33.40 |
| 2 | 0/0.5 | ev≥0.08 px 40-99 gap≤0.2 lead01 high_low obs-only h≥15 | tp30 | 54 trades, 72% win, $43.32 (ROI 8.3%) | $7.50 | $-10.78 |
| 3 | 0.05/0.5 | ev≥0.08 px 40-99 gap≤0.2 lead01 high_low obs-only h≥15 | tp30 | 54 trades, 72% win, $43.32 (ROI 8.3%) | $7.50 | $-10.78 |
| 4 | 0.1/0.5 | ev≥0.08 px 40-99 gap≤0.2 lead01 high_low obs-only h≥15 | tp30 | 54 trades, 72% win, $43.32 (ROI 8.3%) | $7.50 | $-10.78 |
| 5 | 0.2/0.5 | ev≥0.08 px 40-99 gap≤0.2 lead01 high_low obs-only h≥15 | tp30 | 54 trades, 72% win, $43.32 (ROI 8.3%) | $7.50 | $-10.78 |
| 6 | 0.05/0.5 | ev≥0.12 px 40-99 gap≤0.2 lead01 high_low h≥15 | tp30 | 42 trades, 71% win, $39.64 (ROI 9.7%) | $5.84 | $28.09 |
| 7 | 0/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 67 trades, 63% win, $38.45 (ROI 5.9%) | $9.56 | $38.45 |
| 8 | 0.05/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 67 trades, 63% win, $38.45 (ROI 5.9%) | $9.56 | $38.45 |
| 9 | 0.1/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 67 trades, 63% win, $38.45 (ROI 5.9%) | $9.56 | $38.45 |
| 10 | 0.2/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 67 trades, 63% win, $38.45 (ROI 5.9%) | $9.56 | $38.45 |
| 11 | 0/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only | hold | 69 trades, 62% win, $32.91 (ROI 4.9%) | $6.09 | $32.91 |
| 12 | 0.05/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only | hold | 69 trades, 62% win, $32.91 (ROI 4.9%) | $6.09 | $32.91 |
| 13 | 0.1/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only | hold | 69 trades, 62% win, $32.91 (ROI 4.9%) | $6.09 | $32.91 |
| 14 | 0.2/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only | hold | 69 trades, 62% win, $32.91 (ROI 4.9%) | $6.09 | $32.91 |
| 15 | 0/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | cap50 | 67 trades, 70% win, $24.43 (ROI 3.8%) | $5.58 | $38.45 |

### Chosen configuration

- Blend: w=0.1, wObs=0.5
- Filters: minEv 0.12, price 40–99¢, maxProbGap 0.2, lead lead01, metrics high_low, obsBackedOnly false, excludeCities [LAS, DAL, MSY]
- Exits: tp30; restrictions active: 3 (simplicity tie-break within 90% band)

Per fold:

| fold | train | validation |
| --- | --- | --- |
| 1 | 63 trades, 71% win, $1.33 (ROI 0.2%) | 19 trades, 68% win, $10.54 (ROI 5.7%) |
| 2 | 82 trades, 71% win, $11.87 (ROI 1.5%) | 14 trades, 71% win, $5.84 (ROI 4.3%) |
| 3 | 96 trades, 71% win, $17.71 (ROI 1.9%) | 10 trades, 80% win, $27.82 (ROI 28.9%) |

- Pooled validation: 43 trades, 72% win, $44.20 (ROI 10.6%); predicted 15.2¢ vs realized 5.3¢ per contract
- Validation exits: {"take_profit":{"trades":28,"pnlCents":14572},"settled":{"trades":15,"pnlCents":-10152}}
- Hold-to-settle floor: $33.40; predicted-vs-realized winProb gap 10.3pp

## Acceptance checklist

| criterion | result | detail |
| --- | --- | --- |
| validation P&L > 0 in all folds | PASS | worst fold 5.84$ |
| ≥30 pooled / ≥8 per-fold validation trades | PASS | 43 pooled, min fold 10 |
| hold-to-settle pooled validation P&L ≥ 0 | PASS | $33.40 without TP exits |
| pooled validation realized EV ≥ +2¢/contract | PASS | 5.3¢ realized (predicted 15.2¢) |
| predicted-vs-realized winProb gap ≤ 3pp (hold variant) | FAIL | 10.3pp overconfidence |

**Acceptance FAILED — do not apply. Stay in micro-mode and collect more data.**

## Cohort reliability (deduped, at chosen blend weights)

Positive gap = model overconfidence. The live bot bled for weeks on a ~5pp gap that aggregate P&L hid.

| cohort | n | predicted | realized | gap (pp) | avg realized EV (¢) |
| --- | --- | --- | --- | --- | --- |
| high | <40 | lead 0 | obs | 645 | 0.16 | 0.06 | 10.1 | -1.2 |
| low | <40 | lead 1 | fcst | 601 | 0.18 | 0.14 | 4.0 | -1.6 |
| high | <40 | lead 1 | fcst | 515 | 0.12 | 0.09 | 3.0 | -2.6 |
| low | <40 | lead 0 | obs | 377 | 0.23 | 0.09 | 13.5 | -0.2 |
| low | 60-70 | lead 1 | fcst | 223 | 0.70 | 0.64 | 5.9 | -3.7 |
| high | 71-79 | lead 1 | fcst | 184 | 0.76 | 0.65 | 11.0 | -11.9 |
| high | 60-70 | lead 1 | fcst | 172 | 0.67 | 0.72 | -4.2 | 4.4 |
| low | <40 | lead 0 | fcst | 162 | 0.15 | 0.09 | 5.6 | -3.8 |
| high | <40 | lead 0 | fcst | 162 | 0.10 | 0.06 | 3.9 | -3.4 |
| low | 71-79 | lead 1 | fcst | 151 | 0.78 | 0.74 | 3.8 | -1.9 |
| high | 60-70 | lead 0 | obs | 112 | 0.77 | 0.63 | 14.0 | -4.3 |
| high | 51-59 | lead 1 | fcst | 103 | 0.58 | 0.59 | -1.0 | 2.1 |
| high | 80-88 | lead 1 | fcst | 98 | 0.84 | 0.84 | 0.5 | -0.8 |
| low | 51-59 | lead 1 | fcst | 80 | 0.61 | 0.49 | 12.3 | -8.3 |
| high | 71-79 | lead 0 | obs | 75 | 0.84 | 0.68 | 15.8 | -8.6 |
| low | 40-50 | lead 1 | fcst | 72 | 0.53 | 0.47 | 5.7 | 0.1 |
| low | 60-70 | lead 0 | obs | 55 | 0.76 | 0.62 | 13.7 | -4.8 |
| high | 51-59 | lead 0 | obs | 53 | 0.70 | 0.55 | 15.2 | -2.2 |
| low | 80-88 | lead 1 | fcst | 47 | 0.86 | 0.94 | -7.5 | 9.1 |
| low | 80-88 | lead 0 | fcst | 44 | 0.85 | 0.84 | 0.5 | -1.3 |
| high | 80-88 | lead 0 | obs | 44 | 0.90 | 0.82 | 8.4 | -2.4 |
| high | 40-50 | lead 1 | fcst | 41 | 0.49 | 0.54 | -4.8 | 4.9 |
| low | 71-79 | lead 0 | obs | 41 | 0.85 | 0.83 | 1.8 | 6.2 |
| high | 40-50 | lead 0 | obs | 39 | 0.65 | 0.49 | 16.3 | 1.5 |
| low | 80-88 | lead 0 | obs | 34 | 0.91 | 0.94 | -2.9 | 9.1 |
| high | 80-88 | lead 0 | fcst | 32 | 0.84 | 0.75 | 9.1 | -9.2 |
| high | 71-79 | lead 0 | fcst | 31 | 0.78 | 0.84 | -5.4 | 5.8 |
| low | 51-59 | lead 0 | obs | 28 | 0.69 | 0.68 | 1.3 | 10.6 |
| high | <40 | lead 2+ | fcst | 27 | 0.19 | 0.04 | 15.3 | -13.9 |
| low | 40-50 | lead 0 | obs | 26 | 0.60 | 0.42 | 17.9 | -5.1 |

## Where the edge actually is

The forecast inputs (Open-Meteo ensemble, NWS obs) are public — every serious market participant has them, so there is no informational edge in the forecast itself. The two durable edges this dataset supports: (1) same-day observation latency in the LOCAL AFTERNOON, after the daily high has physically formed and the book lags the settlement station (morning same-day entries were −4¢/contract at 13pp overconfidence; post-16h entries +16¢ with the model underconfident); (2) longshot-bias premium at high prices (80–96¢ favorites trading slightly cheap). At $1 stakes the profit scale is cents per day — stake scaling is gated on 2 consecutive profitable live weeks.

## Caveats

- Candidate pool = stored suggestions generated by the live scorer; minEv values below the live floor under-sample the low-edge band.
- Fills at recorded ask + 1¢; exit bids ≈ snapshot probability − 3¢ haircut; no budget/concurrency modeling (fixed $10 stake).
- ~4 weeks of one summer regime; walk-forward folds mitigate but cannot eliminate regime overfit. Keep stakes small until live realized EV matches the backtest.
- Suggestion rows are autocorrelated (hourly re-suggestions); reliability/λ fitting dedups to FIRST-per-ticker (entry-time-honest), the sim dedups one position per ticker+event.
- Re-run weekly: `npm run backtest:weather:fetch && npm run backtest:weather:run && npm run backtest:weather:report`.
