"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read values from the form itself (not React state) so browser
    // autofill/password managers work even without input events.
    const formData = new FormData(e.currentTarget);
    const email = String(formData.get("email") || "");
    const password = String(formData.get("password") || "");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-kalshi-orange to-orange-600 flex items-center justify-center text-white font-bold text-xl shadow-lg">
            KW
          </div>
          <div>
            <h1 className="text-xl font-bold text-kalshi-text leading-tight">
              Kalshi Weather
            </h1>
            <p className="text-xs text-kalshi-muted">
              Prediction Markets + Forecast Analysis
            </p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-kalshi-surface border border-kalshi-border rounded-xl p-6 space-y-4"
        >
          <h2 className="text-base font-bold text-kalshi-text">Sign in</h2>

          <div className="space-y-1">
            <label htmlFor="email" className="text-xs text-kalshi-muted font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full px-3 py-2 rounded-lg bg-black/30 border border-kalshi-border text-sm text-kalshi-text focus:outline-none focus:border-kalshi-orange transition-colors"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-xs text-kalshi-muted font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full px-3 py-2 rounded-lg bg-black/30 border border-kalshi-border text-sm text-kalshi-text focus:outline-none focus:border-kalshi-orange transition-colors"
            />
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-kalshi-red/10 border border-kalshi-red/30">
              <p className="text-xs text-kalshi-red">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-2 rounded-lg bg-kalshi-orange hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
