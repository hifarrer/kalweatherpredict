import Link from "next/link";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events } from "@/db/schema";

export const dynamic = "force-dynamic";

async function openEventCount(section: string): Promise<number | null> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.status, "open"), eq(events.section, section)));
    return row?.n ?? 0;
  } catch {
    return null; // DB unreachable — cards still render
  }
}

const CARD_BASE =
  "group rounded-2xl border border-kalshi-border bg-kalshi-surface/60 p-8 flex flex-col gap-4 transition-all hover:border-kalshi-orange/60 hover:bg-kalshi-surface";

export default async function LandingPage() {
  const [weatherCount, cryptoCount] = await Promise.all([
    openEventCount("weather"),
    openEventCount("crypto"),
  ]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-kalshi-border bg-kalshi-surface/50 backdrop-blur-md">
        <div className="max-w-[1200px] mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-kalshi-orange to-orange-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
            KW
          </div>
          <div>
            <h1 className="text-xl font-bold text-kalshi-text leading-tight">
              Kalshi Markets
            </h1>
            <p className="text-xs text-kalshi-muted">
              Model-driven trading on Kalshi prediction markets
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-4xl">
          <Link href="/weather" className={CARD_BASE}>
            <div className="w-14 h-14 rounded-2xl bg-sky-500/15 flex items-center justify-center text-3xl">
              ☀️
            </div>
            <div>
              <h2 className="text-2xl font-bold text-kalshi-text group-hover:text-kalshi-orange transition-colors">
                Weather
              </h2>
              <p className="text-sm text-kalshi-muted mt-1">
                Daily temperature, rain, and snow markets priced with
                multi-model forecasts and official station observations.
              </p>
            </div>
            <div className="mt-auto flex items-center justify-between text-sm">
              <span className="text-kalshi-muted">
                {weatherCount !== null ? `${weatherCount} open events` : "—"}
              </span>
              <span className="text-kalshi-orange font-semibold">
                Open dashboard →
              </span>
            </div>
          </Link>

          <Link href="/crypto" className={CARD_BASE}>
            <div className="w-14 h-14 rounded-2xl bg-kalshi-orange/15 flex items-center justify-center text-3xl">
              ₿
            </div>
            <div>
              <h2 className="text-2xl font-bold text-kalshi-text group-hover:text-kalshi-orange transition-colors">
                Crypto Perps
              </h2>
              <p className="text-sm text-kalshi-muted mt-1">
                Hourly BTC and ETH price ladders priced with a live-spot
                volatility model — trade direction without holding the coin.
              </p>
            </div>
            <div className="mt-auto flex items-center justify-between text-sm">
              <span className="text-kalshi-muted">
                {cryptoCount !== null ? `${cryptoCount} open events` : "—"}
              </span>
              <span className="text-kalshi-orange font-semibold">
                Open dashboard →
              </span>
            </div>
          </Link>
        </div>
      </main>
    </div>
  );
}
