"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface HeaderProps {
  onRefresh?: () => void;
  loading?: boolean;
}

type Section = "weather" | "crypto" | null;

const WEATHER_NAV = [
  { href: "/weather", label: "Dashboard" },
  { href: "/weather/advantage", label: "AI Advantage" },
  { href: "/weather/automation", label: "Automation" },
  { href: "/weather/stats", label: "Stats" },
  { href: "/weather/history", label: "History" },
];

const CRYPTO_NAV = [
  { href: "/crypto", label: "Dashboard" },
  { href: "/crypto/automation", label: "Automation" },
  { href: "/crypto/stats", label: "Stats" },
  { href: "/crypto/history", label: "History" },
];

function sectionFromPath(pathname: string): Section {
  if (pathname === "/crypto" || pathname.startsWith("/crypto/")) return "crypto";
  if (pathname === "/weather" || pathname.startsWith("/weather/")) return "weather";
  return null;
}

export default function Header({ onRefresh, loading = false }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const section = sectionFromPath(pathname);
  const navLinks = section === "crypto" ? CRYPTO_NAV : section === "weather" ? WEATHER_NAV : [];

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-kalshi-border bg-kalshi-surface/50 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <Link
            href="/"
            className="w-10 h-10 rounded-xl bg-gradient-to-br from-kalshi-orange to-orange-600 flex items-center justify-center text-white font-bold text-lg shadow-lg"
            title="Home"
          >
            KW
          </Link>
          <div className="hidden md:block">
            <h1 className="text-xl font-bold text-kalshi-text leading-tight">
              {section === "crypto" ? "Kalshi Crypto Perps" : "Kalshi Weather"}
            </h1>
            <p className="text-xs text-kalshi-muted">Prediction Markets + Forecast Analysis</p>
          </div>
          {/* Section switcher */}
          <div className="flex items-center rounded-lg bg-black/30 border border-kalshi-border p-0.5 ml-2">
            <Link
              href="/weather"
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                section === "weather"
                  ? "bg-kalshi-orange text-white"
                  : "text-kalshi-muted hover:text-kalshi-text"
              }`}
            >
              Weather
            </Link>
            <Link
              href="/crypto"
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                section === "crypto"
                  ? "bg-kalshi-orange text-white"
                  : "text-kalshi-muted hover:text-kalshi-text"
              }`}
            >
              Crypto
            </Link>
          </div>
        </div>

        <nav className="flex items-center gap-1">
          {navLinks.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? "bg-white/10 text-kalshi-text"
                    : "text-kalshi-muted hover:text-kalshi-orange"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 text-sm text-kalshi-muted">
            <span className="inline-block w-2 h-2 rounded-full bg-kalshi-green animate-pulse" />
            Live Data
          </div>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-kalshi-orange hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center gap-2"
            >
              <svg
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {loading ? "Loading..." : "Refresh"}
            </button>
          )}
          <button
            onClick={handleLogout}
            title="Sign out"
            className="text-sm text-kalshi-muted hover:text-kalshi-orange font-medium transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
