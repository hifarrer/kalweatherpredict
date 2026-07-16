# Weather strategy backtest

Generated 2026-07-16T18:29:24.031Z from dataset fetched 2026-07-16T18:29:02.684Z.

Dataset: 26687 graded weather suggestions; 25907 usable after excluding twc_series (161), target_mismatch (619). Time split at target date 2026-07-12: 15851 train / 10056 validation rows.

## Stage 1 — blend-weight Brier sweep (final snapshots, bug cohort excluded)

| model weight w | Brier |
| --- | --- |
| 0 | 0.0041 |
| 0.1 | 0.0062 |
| 0.2 | 0.0118 |
| 0.3 | 0.0207 |
| 0.4 | 0.0331 |
| 0.5 | 0.0489 |
| 0.65 | 0.0791 |
| 0.8 | 0.1169 |
| 1 | 0.1793 |

## Reliability at w = 0.2, by lead day

Lead 0:

| predicted | observed | n |
| --- | --- | --- |
| 0.01 | 0.00 | 2234 |
| 0.14 | 0.01 | 116 |
| 0.21 | 0.00 | 104 |
| 0.35 | 0.27 | 11 |
| 0.47 | 1.00 | 1 |
| 0.56 | 0.71 | 7 |
| 0.66 | 0.85 | 13 |
| 0.79 | 0.99 | 197 |
| 0.85 | 1.00 | 137 |
| 0.97 | 0.99 | 145 |

Lead 2+:

| predicted | observed | n |
| --- | --- | --- |
| 0.00 | 0.00 | 1067 |
| 0.14 | 0.12 | 17 |
| 0.25 | 0.25 | 4 |
| 0.34 | 0.40 | 5 |
| 0.48 | 1.00 | 1 |
| 0.54 | 1.00 | 2 |
| 0.65 | 1.00 | 5 |
| 0.79 | 1.00 | 353 |

## Stage 2 — filter × exit grid (24300 combos, 3256 profitable on both splits)

| rank | w/wObs | filters | exits | train | validation |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.2/0.5 | ev≥0.08 wp≥0.3 px≥40 gap≤0.2 lead01 −LAS/DAL/MSY | tp50 | 164 trades, 68% win, $54.64 (ROI 3.4%) | 108 trades, 73% win, $93.05 (ROI 8.9%) |
| 2 | 0.2/0.5 | ev≥0.08 wp≥0.4 px≥40 gap≤0.2 lead01 −LAS/DAL/MSY | tp50 | 164 trades, 68% win, $54.64 (ROI 3.4%) | 108 trades, 73% win, $93.05 (ROI 8.9%) |
| 3 | 0.2/0.5 | ev≥0.08 wp≥0.5 px≥40 gap≤0.2 lead01 −LAS/DAL/MSY | tp50 | 164 trades, 68% win, $54.64 (ROI 3.4%) | 108 trades, 73% win, $93.05 (ROI 8.9%) |
| 4 | 0.3/0.35 | ev≥0.08 wp≥0.3 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | hold | 35 trades, 66% win, $8.04 (ROI 2.4%) | 26 trades, 85% win, $92.73 (ROI 36.8%) |
| 5 | 0.3/0.35 | ev≥0.08 wp≥0.4 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | hold | 35 trades, 66% win, $8.04 (ROI 2.4%) | 26 trades, 85% win, $92.73 (ROI 36.8%) |
| 6 | 0.3/0.5 | ev≥0.08 wp≥0.3 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | hold | 35 trades, 66% win, $8.04 (ROI 2.4%) | 26 trades, 85% win, $92.73 (ROI 36.8%) |
| 7 | 0.3/0.5 | ev≥0.08 wp≥0.4 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | hold | 35 trades, 66% win, $8.04 (ROI 2.4%) | 26 trades, 85% win, $92.73 (ROI 36.8%) |
| 8 | 0.3/0.65 | ev≥0.08 wp≥0.3 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | hold | 35 trades, 66% win, $8.04 (ROI 2.4%) | 26 trades, 85% win, $92.73 (ROI 36.8%) |
| 9 | 0.3/0.65 | ev≥0.08 wp≥0.4 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | hold | 35 trades, 66% win, $8.04 (ROI 2.4%) | 26 trades, 85% win, $92.73 (ROI 36.8%) |
| 10 | 0.2/0.5 | ev≥0.08 wp≥0.3 px≥40 gap≤0.2 any −LAS/DAL/MSY | tp50 | 170 trades, 69% win, $68.40 (ROI 4.2%) | 111 trades, 73% win, $87.98 (ROI 8.2%) |
| 11 | 0.2/0.5 | ev≥0.08 wp≥0.4 px≥40 gap≤0.2 any −LAS/DAL/MSY | tp50 | 170 trades, 69% win, $68.40 (ROI 4.2%) | 111 trades, 73% win, $87.98 (ROI 8.2%) |
| 12 | 0.2/0.5 | ev≥0.08 wp≥0.5 px≥40 gap≤0.2 any −LAS/DAL/MSY | tp50 | 170 trades, 69% win, $68.40 (ROI 4.2%) | 111 trades, 73% win, $87.98 (ROI 8.2%) |
| 13 | 0.2/0.5 | ev≥0.08 wp≥0.5 px≥30 gap≤0.2 lead01 −LAS/DAL/MSY | hold | 168 trades, 63% win, $72.87 (ROI 4.5%) | 108 trades, 67% win, $87.57 (ROI 8.4%) |
| 14 | 0.3/0.35 | ev≥0.08 wp≥0.3 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | tp50 | 35 trades, 71% win, $3.72 (ROI 1.1%) | 26 trades, 92% win, $86.59 (ROI 34.3%) |
| 15 | 0.3/0.35 | ev≥0.08 wp≥0.4 px≥30 gap≤0.05 lead1 −LAS/DAL/MSY | tp50 | 35 trades, 71% win, $3.72 (ROI 1.1%) | 26 trades, 92% win, $86.59 (ROI 34.3%) |

### Chosen configuration (rank 1)

- Blend: w=0.2, wObs=0.5
- Filters: minEv 0.08, minWinProb 0.3, minPriceCents 40, maxProbGap 0.2, lead lead01, excludeCities [LAS, DAL, MSY]
- Exits: tp50
- Train: 164 trades, 68% win, $54.64 (ROI 3.4%); predicted 13.0¢ vs realized 1.9¢ per contract
- Validation: 108 trades, 73% win, $93.05 (ROI 8.9%); predicted 12.8¢ vs realized 4.7¢
- Validation exits: {"take_profit":{"trades":52,"pnlCents":27257},"settled":{"trades":56,"pnlCents":-17952}}

No w=0.65 (old weights) combo survived both splits — the re-weighting is doing real work.

## Caveats

- Candidate pool = stored suggestions generated at the old w=0.65 scorer; minEv values below 5¢ under-sample the low-edge band.
- Fills at recorded ask + 1¢; exit bids ≈ snapshot probability − 3¢ haircut; no budget/concurrency modeling (fixed $10 stake).
- Short history (~3 weeks, one summer regime) and the training window predates the same-day model fixes (wrong Houston station, rollover) — the bug cohort is excluded, but residual station bias remains in HOU rows.
- Re-run monthly: `npm run backtest:weather:fetch && npm run backtest:weather:run && npm run backtest:weather:report`.
