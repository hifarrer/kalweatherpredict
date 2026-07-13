/**
 * Shared bits for the hand-rolled SVG charts on the stats pages.
 *
 * Series colors are validated for the dark surface (#16161d): OKLCH lightness
 * band, chroma floor, CVD separation, and contrast. Green/red are the app's
 * status colors, reserved for win/loss and profit/loss sign — never used as
 * plain series identity.
 */
export const CHART = {
  cat1: "#d67a10", // primary series (brand orange, dark-mode step)
  cat2: "#2b9fdb", // comparison series (blue)
  pos: "#2ecc71", // kalshi-green — gains / wins
  neg: "#e74c3c", // kalshi-red — losses
  grid: "rgba(255,255,255,0.07)",
  zero: "rgba(255,255,255,0.22)",
  axisText: "#8b8b9a",
  surface: "#16161d",
};

/** Integer cents → "$1.50" / "-$0.40" (full precision for tooltips). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Integer cents → compact axis label: "$120", "$4.50", "-$0.4". */
export function formatCentsAxis(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  const num =
    dollars >= 100
      ? Math.round(dollars).toLocaleString()
      : parseFloat(dollars.toFixed(2)).toString();
  return `${sign}$${num}`;
}

export function formatPct(frac: number): string {
  return `${(frac * 100).toFixed(0)}%`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "YYYY-MM-DD" → "Jul 10". String split on purpose: new Date("2026-07-10")
 * parses as UTC midnight and renders as the previous day west of Greenwich.
 */
export function formatDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

/** Epoch ms → "Jul 10, 3pm" in the viewer's local time (run timestamps). */
export function formatRunTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h}${ampm}`;
}

/** Clean round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const rawStep = span / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const err = rawStep / mag;
  const step = mag * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1e6; t += step) {
    // clamp float drift (0.30000000000000004 → 0.3)
    ticks.push(parseFloat(t.toPrecision(12)));
  }
  return ticks;
}

/** Linear scale factory. */
export function scaleLinear(
  [d0, d1]: [number, number],
  [r0, r1]: [number, number],
): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Points → SVG path ("M x y L x y …"). */
export function linePath(pts: { x: number; y: number }[]): string {
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}

/**
 * Vertical bar with a 4px-rounded data end and a square baseline.
 * yBase is the baseline edge, yEnd the data end (may be above or below).
 */
export function barPath(
  cx: number,
  yBase: number,
  yEnd: number,
  w: number,
  rounded: boolean,
): string {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const h = Math.abs(yBase - yEnd);
  const r = rounded ? Math.min(4, w / 2, h) : 0;
  if (h < 0.5) return `M${x0} ${yBase} H${x1} V${yEnd} H${x0} Z`;
  if (yEnd < yBase) {
    // grows upward
    return [
      `M${x0} ${yBase}`,
      `L${x0} ${yEnd + r}`,
      `Q${x0} ${yEnd} ${x0 + r} ${yEnd}`,
      `L${x1 - r} ${yEnd}`,
      `Q${x1} ${yEnd} ${x1} ${yEnd + r}`,
      `L${x1} ${yBase}`,
      "Z",
    ].join(" ");
  }
  // grows downward (negative values)
  return [
    `M${x0} ${yBase}`,
    `L${x0} ${yEnd - r}`,
    `Q${x0} ${yEnd} ${x0 + r} ${yEnd}`,
    `L${x1 - r} ${yEnd}`,
    `Q${x1} ${yEnd} ${x1} ${yEnd - r}`,
    `L${x1} ${yBase}`,
    "Z",
  ].join(" ");
}
