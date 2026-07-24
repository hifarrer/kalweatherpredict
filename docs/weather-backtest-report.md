# Weather strategy backtest

Generated 2026-07-24T21:50:09.329Z from dataset fetched 2026-07-24T21:49:52.351Z.

Dataset: 38074 graded weather suggestions; 36520 usable after excluding twc_series (641), target_mismatch (913).

## Walk-forward folds (expanding origin)

| fold | train | validation |
| --- | --- | --- |
| 1 | 2026-07-05 → <2026-07-15 (23206 rows) | 2026-07-15 → 2026-07-17 (5195 rows) |
| 2 | 2026-07-05 → <2026-07-18 (28401 rows) | 2026-07-18 → 2026-07-20 (4213 rows) |
| 3 | 2026-07-05 → <2026-07-21 (32614 rows) | 2026-07-21 → 2026-07-23 (3906 rows) |

## Stage 1 — blend-weight Brier sweep (final snapshots, bug cohort excluded)

| model weight w | Brier |
| --- | --- |
| 0 | 0.0049 |
| 0.1 | 0.0068 |
| 0.2 | 0.0116 |
| 0.3 | 0.0193 |
| 0.4 | 0.0299 |
| 0.5 | 0.0434 |
| 0.65 | 0.0691 |
| 0.8 | 0.1013 |
| 1 | 0.1545 |

**Read stage 1 with care:** final snapshots are captured minutes before close, when the book has already converged on the outcome — so this sweep flatters the market and would pick w≈0. Trading happens hours earlier; the stage-2 simulation (which scores at suggestion time, fee- and price-aware) is the authority on weights.

## Stage 2 — walk-forward grid (32400 combos, 8 survived every fold, 0 λ-calibrated survivors)

| rank | w/wObs | filters | exits | pooled validation | worst fold | hold floor |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0/0.5 | ev≥0.15 px 50-85 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 2 | 0/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 3 | 0.05/0.5 | ev≥0.15 px 50-85 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 4 | 0.05/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 5 | 0.1/0.5 | ev≥0.15 px 50-85 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 6 | 0.1/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 7 | 0.2/0.5 | ev≥0.15 px 50-85 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |
| 8 | 0.2/0.5 | ev≥0.15 px 50-99 gap≤0.2 lead01 high_only obs-only | hold | 53 trades, 64% win, $36.77 (ROI 7.2%) | $0.61 | $36.77 |

### Chosen configuration

- Blend: w=0, wObs=0.5
- Filters: minEv 0.15, price 50–99¢, maxProbGap 0.2, lead lead01, metrics high_only, obsBackedOnly true, excludeCities [LAS, DAL, MSY]
- Exits: hold; restrictions active: 4 (simplicity tie-break within 90% band)

Per fold:

| fold | train | validation |
| --- | --- | --- |
| 1 | 58 trades, 72% win, $131.52 (ROI 23.4%) | 12 trades, 67% win, $11.77 (ROI 10.1%) |
| 2 | 70 trades, 71% win, $143.29 (ROI 21.1%) | 22 trades, 59% win, $0.61 (ROI 0.3%) |
| 3 | 92 trades, 68% win, $143.90 (ROI 16.2%) | 19 trades, 68% win, $24.39 (ROI 13.3%) |

- Pooled validation: 53 trades, 64% win, $36.77 (ROI 7.2%); predicted 16.0¢ vs realized 4.7¢ per contract
- Validation exits: {"settled":{"trades":53,"pnlCents":3677}}
- Hold-to-settle floor: $36.77; predicted-vs-realized winProb gap 10.3pp

## Acceptance checklist

| criterion | result | detail |
| --- | --- | --- |
| validation P&L > 0 in all folds | PASS | worst fold 0.61$ |
| ≥30 pooled / ≥8 per-fold validation trades | PASS | 53 pooled, min fold 12 |
| hold-to-settle pooled validation P&L ≥ 0 | PASS | $36.77 without TP exits |
| pooled validation realized EV ≥ +2¢/contract | PASS | 4.7¢ realized (predicted 16.0¢) |
| predicted-vs-realized winProb gap ≤ 3pp (hold variant) | FAIL | 10.3pp overconfidence |

**Acceptance FAILED — do not apply. Stay in micro-mode and collect more data.**

## Cohort reliability (deduped, at chosen blend weights)

Positive gap = model overconfidence. The live bot bled for weeks on a ~5pp gap that aggregate P&L hid.

| cohort | n | predicted | realized | gap (pp) | avg realized EV (¢) |
| --- | --- | --- | --- | --- | --- |
| high | <40 | lead 0 | obs | 1153 | 0.18 | 0.07 | 11.8 | 1.3 |
| low | <40 | lead 0 | obs | 809 | 0.27 | 0.08 | 18.9 | 0.0 |
| low | <40 | lead 0 | fcst | 246 | 0.11 | 0.10 | 0.8 | 0.5 |
| high | <40 | lead 0 | fcst | 206 | 0.09 | 0.11 | -2.1 | 1.9 |
| low | <40 | lead 1 | fcst | 154 | 0.19 | 0.20 | -0.9 | 4.7 |
| high | 71-79 | lead 0 | fcst | 131 | 0.75 | 0.96 | -21.1 | 19.1 |
| high | 80-88 | lead 0 | fcst | 82 | 0.84 | 0.96 | -12.8 | 11.7 |
| low | 80-88 | lead 0 | fcst | 78 | 0.84 | 0.99 | -14.2 | 12.9 |
| high | <40 | lead 1 | fcst | 74 | 0.09 | 0.15 | -5.6 | 5.9 |
| high | 60-70 | lead 0 | obs | 65 | 0.74 | 0.95 | -21.2 | 29.1 |
| low | 60-70 | lead 0 | obs | 58 | 0.76 | 0.97 | -20.5 | 29.2 |
| low | 89+ | lead 0 | obs | 52 | 0.98 | 0.98 | -0.4 | 2.3 |
| high | 51-59 | lead 0 | obs | 52 | 0.69 | 0.98 | -29.5 | 40.5 |
| high | 71-79 | lead 0 | obs | 46 | 0.84 | 0.98 | -14.1 | 20.8 |
| low | 71-79 | lead 0 | obs | 45 | 0.84 | 0.87 | -3.0 | 10.3 |
| high | 40-50 | lead 0 | obs | 44 | 0.62 | 0.93 | -31.3 | 45.1 |
| low | 60-70 | lead 0 | fcst | 38 | 0.68 | 0.95 | -27.0 | 26.2 |
| high | <40 | lead 2+ | fcst | 38 | 0.16 | 0.03 | 13.4 | -15.2 |
| low | 71-79 | lead 0 | fcst | 38 | 0.77 | 0.92 | -14.7 | 14.4 |
| low | 51-59 | lead 0 | obs | 36 | 0.67 | 0.94 | -27.3 | 37.3 |
| high | 80-88 | lead 1 | fcst | 35 | 0.84 | 1.00 | -16.3 | 15.1 |
| high | 80-88 | lead 0 | obs | 35 | 0.90 | 1.00 | -9.9 | 15.9 |
| low | 71-79 | lead 1 | fcst | 34 | 0.78 | 0.91 | -12.7 | 13.6 |
| low | 89+ | lead 0 | fcst | 34 | 0.94 | 1.00 | -6.1 | 6.1 |
| low | 80-88 | lead 0 | obs | 34 | 0.92 | 1.00 | -7.9 | 14.7 |
| low | 40-50 | lead 0 | obs | 32 | 0.60 | 0.72 | -12.1 | 24.8 |
| high | 60-70 | lead 0 | fcst | 32 | 0.69 | 0.88 | -18.5 | 18.4 |
| high | 40-50 | lead 0 | fcst | 26 | 0.45 | 0.58 | -12.7 | 10.4 |
| low | 80-88 | lead 1 | fcst | 25 | 0.87 | 1.00 | -12.8 | 14.6 |
| high | 51-59 | lead 0 | fcst | 23 | 0.56 | 0.74 | -18.1 | 17.2 |

## Caveats

- Candidate pool = stored suggestions generated by the live scorer; minEv values below the live floor under-sample the low-edge band.
- Fills at recorded ask + 1¢; exit bids ≈ snapshot probability − 3¢ haircut; no budget/concurrency modeling (fixed $10 stake).
- ~4 weeks of one summer regime; walk-forward folds mitigate but cannot eliminate regime overfit. Keep stakes small until live realized EV matches the backtest.
- Suggestion rows are autocorrelated (hourly re-suggestions); reliability/λ fitting dedups to last-per-ticker, the sim dedups one position per ticker+event.
- Re-run weekly: `npm run backtest:weather:fetch && npm run backtest:weather:run && npm run backtest:weather:report`.
