/**
 * Approximation of the error function (Abramowitz & Stegun 7.1.26).
 * Max error ~1.5×10⁻⁷.
 */
export function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Cumulative distribution function of a normal distribution.
 * Returns P(X <= x) where X ~ N(mean, std²).
 */
export function normalCdf(x: number, mean: number, std: number): number {
  return 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
