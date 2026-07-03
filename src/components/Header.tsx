interface HeaderProps {
  onRefresh: () => void;
  loading: boolean;
}

export default function Header({ onRefresh, loading }: HeaderProps) {
  return (
    <header className="border-b border-kalshi-border bg-kalshi-surface/50 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-kalshi-orange to-orange-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
            KW
          </div>
          <div>
            <h1 className="text-xl font-bold text-kalshi-text leading-tight">
              Kalshi Weather
            </h1>
            <p className="text-xs text-kalshi-muted">Prediction Markets + Forecast Analysis</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="/stats"
            className="text-sm text-kalshi-muted hover:text-kalshi-orange font-medium transition-colors"
          >
            Stats
          </a>
          <div className="hidden sm:flex items-center gap-2 text-sm text-kalshi-muted">
            <span className="inline-block w-2 h-2 rounded-full bg-kalshi-green animate-pulse" />
            Live Data
          </div>
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
        </div>
      </div>
    </header>
  );
}
