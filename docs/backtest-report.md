# Crypto Strategy Backtest Report

Generated: 2026-07-12T03:17:33.806Z · Grid: `full`

## Dataset

- 930 settled Kalshi crypto events (10 days, fetched 2026-07-12T03:15:01.973Z)
- Time split at 2026-07-09T01:00:00.000Z: 648 train / 282 validation events
- Replay: real per-minute Kalshi bid/ask candlesticks; fills at ask + 1¢ adverse haircut; Kalshi quadratic fee per contract; $10 fixed stake; one position per event ladder.

## Model selection (stage 1 — Brier score on train split)

| Model (volMode/preset/ivβ/mult) | Train Brier | Val Brier | Market Brier | Samples |
|---|---|---|---|---|
| rms/balanced/β0/m0.9 | 0.0386 | 0.0380 | 0.0858 | 111670 |
| rms/short/β0/m0.9 | 0.0386 | 0.0379 | 0.0858 | 111670 |
| rms/short/β0.25/m0.9 | 0.0387 | 0.0384 | 0.0858 | 111670 |
| rms/balanced/β0.25/m0.9 | 0.0387 | 0.0385 | 0.0858 | 111670 |
| rms/long/β0/m0.9 | 0.0387 | 0.0382 | 0.0858 | 111670 |
| ewma/short/β0/m0.9 | 0.0387 | 0.0379 | 0.0858 | 111670 |
| ewma/short/β0.25/m0.9 | 0.0387 | 0.0384 | 0.0858 | 111670 |
| ewma/balanced/β0/m0.9 | 0.0387 | 0.0380 | 0.0858 | 111670 |
| ewma/balanced/β0.25/m0.9 | 0.0387 | 0.0385 | 0.0858 | 111670 |
| rms/short/β0.4/m0.9 | 0.0388 | 0.0387 | 0.0858 | 111670 |

## Best model diagnostics (rms/balanced/β0/m0.9)

| τ bucket | Samples | Model Brier | Market Brier |
|---|---|---|---|
| 15-60m | 86115 | 0.0455 | 0.0921 |
| 0-15m | 31652 | 0.0251 | 0.0933 |
| 4-24h | 15190 | 0.0383 | 0.0694 |
| 1-4h | 20737 | 0.0297 | 0.0697 |

Calibration (predicted vs realized YES rate):

| Predicted bin | Samples | Mean predicted | Realized |
|---|---|---|---|
| 0-10% | 72487 | 1.2% | 1.1% |
| 10-20% | 9740 | 14.5% | 13.7% |
| 20-30% | 5315 | 24.6% | 24.8% |
| 30-40% | 3138 | 34.6% | 33.8% |
| 40-50% | 2387 | 44.9% | 50.0% |
| 50-60% | 2076 | 54.9% | 64.5% |
| 60-70% | 2073 | 65.0% | 76.3% |
| 70-80% | 2364 | 75.0% | 82.2% |
| 80-90% | 3030 | 85.4% | 91.9% |
| 90-100% | 51084 | 99.4% | 99.6% |

## Strategy results (stage 2 — profitable on both splits, ranked by validation P&L)

| Model | Filters | Split | Trades | Win rate | P&L | ROI | Max DD | Pred EV | Realized EV |
|---|---|---|---|---|---|---|---|---|---|
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.2/sb15m/hold | train | 194 | 59% | $358.69 | 18.9% | $82.66 | 7.5¢ | 9.8¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.2/sb15m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.2/sb30m/hold | train | 194 | 59% | $358.69 | 18.9% | $82.66 | 7.5¢ | 9.8¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.2/sb30m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.2/sb45m/hold | train | 194 | 59% | $358.69 | 18.9% | $82.66 | 7.5¢ | 9.8¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.2/sb45m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.35/sb15m/hold | train | 196 | 59% | $338.94 | 17.7% | $82.66 | 7.6¢ | 9.2¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.35/sb15m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.35/sb30m/hold | train | 196 | 59% | $338.94 | 17.7% | $82.66 | 7.6¢ | 9.2¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.35/sb30m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.35/sb45m/hold | train | 196 | 59% | $338.94 | 17.7% | $82.66 | 7.6¢ | 9.2¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.35/sb45m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.5/sb15m/hold | train | 196 | 59% | $338.94 | 17.7% | $82.66 | 7.6¢ | 9.2¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.5/sb15m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.5/sb30m/hold | train | 196 | 59% | $338.94 | 17.7% | $82.66 | 7.6¢ | 9.2¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.5/sb30m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.5/sb45m/hold | train | 196 | 59% | $338.94 | 17.7% | $82.66 | 7.6¢ | 9.2¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ1h/gap0.5/sb45m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.2/sb15m/hold | train | 197 | 59% | $352.71 | 18.3% | $82.66 | 7.5¢ | 9.7¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.2/sb15m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.2/sb30m/hold | train | 197 | 59% | $352.71 | 18.3% | $82.66 | 7.5¢ | 9.7¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.2/sb30m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.2/sb45m/hold | train | 197 | 59% | $352.71 | 18.3% | $82.66 | 7.5¢ | 9.7¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.2/sb45m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.35/sb15m/hold | train | 199 | 59% | $332.96 | 17.1% | $82.66 | 7.6¢ | 9.1¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.35/sb15m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.35/sb30m/hold | train | 199 | 59% | $332.96 | 17.1% | $82.66 | 7.6¢ | 9.1¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.35/sb30m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.35/sb45m/hold | train | 199 | 59% | $332.96 | 17.1% | $82.66 | 7.6¢ | 9.1¢ |
| rms/balanced/β0/m0.9 | ev5/wp0.3/px30/τ3h/gap0.35/sb45m/hold | val | 86 | 71% | $371.96 | 44.2% | $65.80 | 7.6¢ | 20.0¢ |

## Chosen configuration

**rms/balanced/β0/m0.9** with filters **ev5/wp0.3/px30/τ1h/gap0.2/sb15m/hold**

- Train: 194 trades, P&L $358.69, win 59%, ROI 18.9%, maxDD $82.66, predEV 7.5¢ vs realized 9.8¢
- Validation: 86 trades, P&L $371.96, win 71%, ROI 44.2%, maxDD $65.80, predEV 7.6¢ vs realized 20.0¢

These values are baked into `DEFAULT_CRYPTO_PARAMS` (src/lib/crypto/params.ts) and the crypto automation defaults (src/lib/crypto/cryptoSettings.ts).

## Caveats

- Fills are simulated at the posted ask (+1¢) with no queue/impact modeling; real IOC fills can be worse in fast markets.
- Coinbase spot proxies the CF Benchmarks settlement index; small basis differences exist.
- The window is short (10 days) and one vol regime; re-run the backtest periodically (`npm run backtest:fetch && npm run backtest:run`) as settled data accumulates.
