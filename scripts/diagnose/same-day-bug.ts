import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Diagnostic for the same-day weather "certain loser" cohort: graded weather
 * suggestions with win_prob >= 0.99 that lost. Live data shows 147 such picks
 * winning only ~41% of the time — this script classifies each one against the
 * candidate root causes so the fixes can be targeted:
 *
 *   H1  midnight rollover — resolveForecastIndex scored yesterday's still-open
 *       event against today's forecast (signature: suggestions.target_date
 *       differs from settlements.target_date)
 *   H4  unblendable-extreme hole — blendableMarketProb returned null at a
 *       0.99+ book, giving the (broken) model 100% weight (signature:
 *       market_prob IS NULL)
 *   H2/H3/H5  decided/obs-forced paths — implied blend weight ~1 with a
 *       market price present; bucketed by city-local hour for the H1-adjacent
 *       midnight spike and checked against raw NWS observations with --nws
 *
 * Read-only. Usage:
 *   npm run diagnose:same-day            # DB-only analysis
 *   npm run diagnose:same-day -- --nws   # + spot-check cases against api.weather.gov
 */

function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(join(process.cwd(), file), "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        if (process.env[key] !== undefined) continue;
        process.env[key] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // file missing is fine
    }
  }
}

interface CohortRow {
  id: number;
  market_ticker: string;
  city_code: string | null;
  metric: string | null;
  side: string;
  price: number;
  win_prob: number;
  forecast_prob: number;
  blended_prob: number;
  market_prob: number | null;
  sugg_target: string | null;
  settle_target: string | null;
  result: string;
  actual_value: number | null;
  strike_type: string | null;
  floor_strike: number | null;
  cap_strike: number | null;
  created_at: Date;
}

type Classification = "H1_rollover" | "H4_blend_hole" | "decided_path" | "other";

function classify(row: CohortRow): Classification {
  if (row.sugg_target && row.settle_target && row.sugg_target !== row.settle_target) {
    return "H1_rollover";
  }
  if (row.market_prob === null) return "H4_blend_hole";
  const denom = row.forecast_prob - (row.market_prob ?? 0);
  if (Math.abs(denom) > 0.05) {
    const w = (row.blended_prob - (row.market_prob ?? 0)) / denom;
    if (w > 0.9) return "decided_path";
  }
  return "other";
}

function localHour(date: Date, timezone: string | undefined): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(date);
    return parseInt(s, 10) % 24;
  } catch {
    return date.getUTCHours();
  }
}

function table(headers: string[], rows: (string | number | null)[][]): string {
  const fmt = (v: string | number | null) => (v === null || v === undefined ? "" : String(v));
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(fmt).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function count<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set (checked env, .env.local, .env)");
    process.exit(1);
  }
  const { pool } = await import("@/db/client");
  const { CITY_MAP } = await import("@/lib/cities");
  const runNws = process.argv.includes("--nws");

  // ---- Q1: cohort + classification -----------------------------------------
  const cohortRes = await pool.query(`
    SELECT s.id, s.market_ticker, s.city_code, s.metric, s.side, s.price,
           s.win_prob, s.forecast_prob, s.blended_prob, s.market_prob,
           s.target_date AS sugg_target, st.target_date AS settle_target,
           st.result, st.actual_value, st.strike_type, st.floor_strike, st.cap_strike,
           s.created_at
    FROM suggestions s
    JOIN settlements st ON st.market_ticker = s.market_ticker
    WHERE s.section = 'weather' AND s.graded_at IS NOT NULL
      AND s.win_prob >= 0.99 AND s.suggested_side_won = false
    ORDER BY s.created_at
  `);
  const cohort = cohortRes.rows as CohortRow[];

  console.log(`# Same-day bug diagnosis\n`);
  console.log(`Cohort: ${cohort.length} graded weather suggestions with win_prob >= 0.99 that lost.\n`);

  const classified = cohort.map((row) => ({ row, cls: classify(row) }));
  console.log(`## Q1 — classification by hypothesis\n`);
  console.log(
    table(
      ["classification", "n", "share"],
      [...count(classified, (c) => c.cls).entries()].map(([cls, n]) => [
        cls,
        n,
        `${((100 * n) / cohort.length).toFixed(1)}%`,
      ]),
    ),
  );

  console.log(`\nBy classification x city/metric:\n`);
  console.log(
    table(
      ["classification", "city", "metric", "n"],
      [...count(classified, (c) => `${c.cls}|${c.row.city_code}|${c.row.metric}`).entries()].map(
        ([key, n]) => {
          const [cls, city, metric] = key.split("|");
          return [cls, city, metric, n];
        },
      ),
    ),
  );

  console.log(`\nBy city-local hour of suggestion creation:\n`);
  const hourOf = (r: CohortRow) =>
    localHour(new Date(r.created_at), r.city_code ? CITY_MAP[r.city_code]?.timezone : undefined);
  console.log(
    table(
      ["classification", "local hour", "n"],
      [...count(classified, (c) => `${c.cls}|${String(hourOf(c.row)).padStart(2, "0")}`).entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, n]) => {
          const [cls, hour] = key.split("|");
          return [cls, hour, n];
        }),
    ),
  );

  console.log(`\nExample rows per classification (up to 3 each):\n`);
  const seen = new Map<Classification, number>();
  const examples: (string | number | null)[][] = [];
  for (const { row, cls } of classified) {
    const k = seen.get(cls) ?? 0;
    if (k >= 3) continue;
    seen.set(cls, k + 1);
    examples.push([
      cls,
      row.market_ticker,
      row.side,
      row.price.toFixed(2),
      row.forecast_prob.toFixed(3),
      row.market_prob === null ? "NULL" : row.market_prob.toFixed(2),
      row.sugg_target,
      row.settle_target,
      `${row.result}@${row.actual_value}`,
    ]);
  }
  console.log(
    table(
      ["class", "ticker", "side", "price", "model P(yes)", "mkt P(yes)", "sugg target", "settle target", "settled"],
      examples,
    ),
  );

  // How widespread is the rollover beyond the 0.99 cohort?
  const mismatchRes = await pool.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE s.target_date <> st.target_date)::int AS mismatched,
           count(*) FILTER (WHERE s.target_date <> st.target_date AND s.suggested_side_won = false)::int AS mismatched_lost
    FROM suggestions s
    JOIN settlements st ON st.market_ticker = s.market_ticker
    WHERE s.section = 'weather' AND s.graded_at IS NOT NULL
      AND s.target_date IS NOT NULL AND st.target_date IS NOT NULL
  `);
  const mm = mismatchRes.rows[0];
  console.log(
    `\nAll graded weather suggestions: ${mm.n}; target-date mismatch (H1 signature): ${mm.mismatched} (${((100 * mm.mismatched) / mm.n).toFixed(1)}%), of which lost: ${mm.mismatched_lost}\n`,
  );

  // ---- Q2: when did the probability pin? ------------------------------------
  const tickers = [...new Set(cohort.map((r) => r.market_ticker))];
  const snapRes = await pool.query(
    `SELECT market_ticker, captured_at, predicted_prob, city_code
     FROM prediction_snapshots
     WHERE market_ticker = ANY($1) AND section = 'weather'
     ORDER BY market_ticker, captured_at`,
    [tickers],
  );
  const byTicker = new Map<string, { captured_at: Date; predicted_prob: number; city_code: string | null }[]>();
  for (const s of snapRes.rows) {
    const arr = byTicker.get(s.market_ticker) ?? [];
    arr.push(s);
    byTicker.set(s.market_ticker, arr);
  }
  const pinHours: string[] = [];
  let pinnedFromFirst = 0;
  let neverPinned = 0;
  for (const [ticker, snaps] of byTicker) {
    const idx = snaps.findIndex((s) => s.predicted_prob >= 0.98 || s.predicted_prob <= 0.02);
    if (idx < 0) {
      neverPinned++;
      continue;
    }
    if (idx === 0) pinnedFromFirst++;
    const s = snaps[idx];
    const tz = s.city_code ? CITY_MAP[s.city_code]?.timezone : undefined;
    pinHours.push(String(localHour(new Date(s.captured_at), tz)).padStart(2, "0"));
    void ticker;
  }
  console.log(`## Q2 — first pinned snapshot (predicted_prob outside 0.02..0.98), city-local hour\n`);
  console.log(
    `${byTicker.size} cohort markets with snapshots; pinned from very first snapshot: ${pinnedFromFirst}; never pinned in snapshots: ${neverPinned}\n`,
  );
  console.log(
    table(
      ["local hour", "n markets"],
      [...count(pinHours, (h) => h).entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
  );

  // ---- Q3: sigma calibration with vs without target-date match --------------
  console.log(`\n## Q3 — sigma calibration poison (calibrationStore query +/- target_date match)\n`);
  const madSql = (withMatch: boolean) => `
    WITH graded AS (
      SELECT DISTINCT ON (s.event_ticker, s.lead_days)
        s.metric, s.lead_days, (st.actual_value - s.forecast_value) AS err
      FROM prediction_snapshots s
      JOIN settlements st ON st.market_ticker = s.market_ticker
      WHERE st.actual_value IS NOT NULL
        AND s.forecast_value IS NOT NULL
        AND s.lead_days IS NOT NULL
        AND s.section = 'weather'
        ${withMatch ? "AND s.target_date = st.target_date" : ""}
      ORDER BY s.event_ticker, s.lead_days, s.captured_at DESC
    ), bucketed AS (
      SELECT metric,
        CASE WHEN lead_days <= 0 THEN '0' WHEN lead_days = 1 THEN '1'
             WHEN lead_days = 2 THEN '2' WHEN lead_days <= 4 THEN '3-4'
             WHEN lead_days <= 7 THEN '5-7' ELSE '8+' END AS bucket,
        err
      FROM graded
    ), med AS (
      SELECT metric, bucket, percentile_cont(0.5) WITHIN GROUP (ORDER BY err) AS median_err
      FROM bucketed GROUP BY 1, 2
    )
    SELECT b.metric, b.bucket,
      round(stddev_samp(b.err)::numeric, 2) AS sigma_sd,
      round((1.4826 * percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(b.err - m.median_err)))::numeric, 2) AS sigma_mad,
      count(*)::int AS n
    FROM bucketed b JOIN med m ON m.metric = b.metric AND m.bucket = b.bucket
    GROUP BY 1, 2 ORDER BY 1, 2`;

  const [sigAll, sigMatched] = await Promise.all([
    pool.query(madSql(false)),
    pool.query(madSql(true)),
  ]);
  const matchedMap = new Map(
    sigMatched.rows.map((r: Record<string, unknown>) => [`${r.metric}|${r.bucket}`, r]),
  );
  console.log(
    table(
      ["metric", "lead bucket", "sigma (current)", "sigma (date-matched)", "MAD sigma (date-matched)", "n -> n"],
      sigAll.rows.map((r: Record<string, unknown>) => {
        const m = matchedMap.get(`${r.metric}|${r.bucket}`) as Record<string, unknown> | undefined;
        return [
          String(r.metric),
          String(r.bucket),
          String(r.sigma_sd),
          m ? String(m.sigma_sd) : "-",
          m ? String(m.sigma_mad) : "-",
          `${r.n} -> ${m ? m.n : 0}`,
        ];
      }),
    ),
  );

  // ---- Q4: NWS raw-observation spot checks (optional, network) ---------------
  if (runNws) {
    console.log(`\n## Q4 — NWS observation spot-checks (civil day vs LST climate day)\n`);
    const picks = cohort
      .filter((r) => r.metric === "temperature_low" && r.settle_target && r.city_code && CITY_MAP[r.city_code]?.station?.id)
      .filter((r, i, a) => a.findIndex((x) => x.market_ticker === r.market_ticker) === i)
      .slice(0, 5);
    for (const r of picks) {
      const city = CITY_MAP[r.city_code!];
      const station = city.station!.id;
      const tz = city.timezone;
      const day = r.settle_target!;
      // Fetch a generous UTC window around the local day (12h padding each side).
      const start = new Date(`${day}T00:00:00Z`);
      start.setUTCHours(start.getUTCHours() - 12);
      const end = new Date(`${day}T23:59:59Z`);
      end.setUTCHours(end.getUTCHours() + 14);
      const url = `https://api.weather.gov/stations/${station}/observations?start=${start.toISOString().replace(/\.\d+Z$/, "Z")}&end=${end.toISOString().replace(/\.\d+Z$/, "Z")}&limit=500`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "kalshi-weather-diagnostics (contact: local dev)", Accept: "application/geo+json" },
        });
        if (!res.ok) {
          console.log(`- ${r.market_ticker} (${station}): NWS fetch failed ${res.status}`);
          continue;
        }
        const json = (await res.json()) as {
          features?: { properties?: { timestamp?: string; temperature?: { value: number | null; qualityControl?: string } } }[];
        };
        const obs = (json.features ?? [])
          .map((f) => f.properties)
          .filter((p): p is NonNullable<typeof p> => !!p && p.temperature?.value != null)
          .map((p) => ({
            t: new Date(p.timestamp!),
            f: (p.temperature!.value! * 9) / 5 + 32,
            qc: p.temperature!.qualityControl ?? "",
          }));
        const civilDay = obs.filter(
          (o) =>
            new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(o.t) === day,
        );
        // LST day: shift by the standard (January) offset for the zone.
        const janOffsetMs =
          new Date(Date.UTC(2026, 0, 15, 12)).getTime() -
          new Date(new Date(Date.UTC(2026, 0, 15, 12)).toLocaleString("en-US", { timeZone: tz })).getTime();
        const lstDay = obs.filter((o) => {
          const shifted = new Date(o.t.getTime() - janOffsetMs);
          return shifted.toISOString().slice(0, 10) === day;
        });
        const min = (arr: typeof obs) => (arr.length ? Math.min(...arr.map((o) => o.f)).toFixed(1) : "n/a");
        const flagged = civilDay.filter((o) => /:[VZQ]$/.test(o.qc)).length;
        console.log(
          `- ${r.market_ticker} (${station}, ${day}): settle actual=${r.actual_value}; civil-day min=${min(civilDay)} (${civilDay.length} obs, ${flagged} flagged QC); LST-day min=${min(lstDay)} (${lstDay.length} obs)`,
        );
      } catch (err) {
        console.log(`- ${r.market_ticker} (${station}): NWS fetch error ${(err as Error).message}`);
      }
    }
  } else {
    console.log(`\n(Q4 NWS spot-checks skipped — pass --nws to run them.)`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
