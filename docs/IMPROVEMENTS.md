# KalshiWeather Improvements — Phased Plan

> Reference this file from any chat session. Tick phases off as they ship.

## Status

- [x] Phase 1 — Authentication (users table, login, middleware) — shipped 2026-07-04
- [x] Phase 2 — Maximized event view modal — shipped 2026-07-04
- [x] Phase 3 — Kalshi trading (market buy orders) — shipped 2026-07-04 (live order untested until KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_BASE64 are set in .env)
- [x] Phase 4 — Suggested actions — shipped 2026-07-04
- [x] Phase 5 — Deep AI analysis improvements — shipped 2026-07-04 (~1¢/call: 1.8k in / 0.3k out tokens)
- [x] Phase 6 — AI Advantage page + nav — shipped 2026-07-04

## Context

Single-owner Kalshi weather-market dashboard (Next.js 16 App Router, React 19, TypeScript, Tailwind, Postgres on Railway via Drizzle, Anthropic SDK). Owner wants: a maximized per-event view, login security, real-money buying via the Kalshi trade API, algorithmic "suggested actions," a richer/cheaper Deep AI Analysis, and a new "AI Advantage" page that ranks profit opportunities across all events.

**User decisions (confirmed 2026-07-04):**
- Orders are **market orders** (with a max-cost guard, see Phase 3).
- **Straight to production** Kalshi API — no demo environment. Safety = confirmation modal + `MAX_ORDER_CONTRACTS` cap.
- AI Advantage = **algorithmic EV ranking + one cheap Claude summary** of the top opportunities.
- Deep AI Analysis model stays `claude-sonnet-4-5` but read from env `ANALYZE_MODEL` so it's switchable without deploys.
- Buy-only for now (no sell/position management). Session cookie: 30 days.

## Existing building blocks to reuse (do not reinvent)

- `src/lib/enrich.ts` — `buildEnrichedEvents(rows)` / `enrichSingleEvent(event, cityCode)`: produce `EnrichedEvent` with `prediction.marketLikelihoods[]` (`probability` = forecast-implied P(YES), `marketProb`, `edge`, `decided`, `forecastValue`), `opportunityScore`, `maxEdge`. This is the data backbone for Phases 2, 4, 5, 6.
- `src/lib/predictor.ts` — `impliedMarketProb`, `computeOpportunityScore`, sigma/CDF logic. `EDGE_MIN_VOLUME = 100` liquidity constant (currently duplicated in `enrich.ts` and `MarketsList.tsx` — export from one place).
- `src/components/AiAnalysisModal.tsx` — the modal pattern (fixed inset-0 z-[100], backdrop blur, scrollable body).
- `src/components/MarketsList.tsx` — `formatStrike`, prob/edge badge styling → extract shared helpers to `src/lib/format.ts`.
- `src/components/ForecastPanel.tsx` — expanded forecast; `DailyForecast.byModel` + `spread` already carry per-model data.
- `src/instrumentation.ts` — runs migrations + starts scheduler on boot; hook admin seeding here.
- `src/db/schema.ts` + `drizzle/` — schema changes via `npm run db:generate`; migrations auto-apply on boot.
- Kalshi read client `src/lib/kalshi.ts` stays as-is (public API); trading gets its own authenticated client.

---

## Phase 1 — Authentication (login page, users table)

**Schema** (`src/db/schema.ts` + `npm run db:generate`):
```
users: id bigserial PK, email text unique NOT NULL, passwordHash text NOT NULL,
       role text NOT NULL default 'admin',
       kalshiApiKeyId text NULL, kalshiPrivateKeyEnc text NULL,   -- future per-user keys
       createdAt timestamptz default now()
```

**New dependency:** `jose` (JWT verification works in the Edge runtime where middleware runs). Password hashing via `node:crypto` scrypt — no bcrypt dependency.

**Create:**
- `src/lib/auth.ts` — scrypt `hashPassword`/`verifyPassword` (timing-safe compare), HS256 session JWT (`createSessionToken`/`verifySessionToken`, signed with `AUTH_SECRET`, 30-day exp), cookie name `kw_session`.
- `src/lib/seedAdmin.ts` — upsert admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` when missing; call from `instrumentation.ts` after `runMigrations()`.
- `src/app/login/page.tsx` — kalshi-themed email+password card → POST `/api/login` → redirect `/`.
- `src/app/api/login/route.ts` — verify, set httpOnly+secure+sameSite=lax cookie; small in-memory rate limit (5 fails/min/IP).
- `src/app/api/logout/route.ts` — clear cookie.
- Middleware — Next 16 renamed `middleware.ts` → `proxy.ts`; check which 16.2.9 expects and create that file at `src/`. Logic: no valid JWT → pages redirect to `/login`, `/api/*` → 401 JSON. Matcher excludes `/login`, `/api/login`, `/_next/*`, favicon/static.

**Modify:** `src/instrumentation.ts`, `.env.example` (`AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`), `Header.tsx` (Logout button).

Note: the in-process sync scheduler never goes through HTTP, so middleware doesn't affect it.

**Verify:** logged-out `/` redirects to `/login`; `curl /api/events` → 401; login works and survives restart; users row exists after boot.

---

## Phase 2 — Maximized event view

**Approach: modal (not a route).** Dashboard already holds every `EnrichedEvent` + forecast client-side; a large modal keeps filters/scroll state. (Optional later: `?event=TICKER` deep link.)

**Create:**
- `src/components/EventDetailModal.tsx` — `max-w-5xl`, `max-h-[85vh]`, sections:
  - **Header:** title, sub_title, city, `PredictionBadge`, opportunity score, close countdown, per-event refresh (reuse the `/api/events/[eventTicker]` refresh from `EventCard` — lift into shared hook `useEventRefresh`), "Open on Kalshi" link, Deep AI Analysis button.
  - **Expanded forecast:** `ForecastPanel` open by default + a per-model table for the target date from `daily[i].byModel` (Model | High | Low | Precip | Snow; footer: ensemble median, spread, agreement badge). Show `stationObs` / `observedSoFar` when present.
  - **Markets table** (`src/components/MarketsTable.tsx`): ALL markets with labeled headers: Outcome | Strike | Forecast % | Market % | Edge | Yes bid/ask | No bid/ask | Last | 24h Vol. Sort by forecast prob desc; highlight `decided` rows. Reuse extracted `formatStrike`/`formatVolume` from `src/lib/format.ts`.
  - Placeholder slots for Suggested Actions (Phase 4) and Buy buttons (Phase 3).

**Modify:** `EventCard.tsx` — title `<a>` → `<button>` opening the modal (keep hover style); **View button unchanged** (still opens Kalshi).

**Verify:** title opens modal with all markets + column names; per-model rows match `/api/weather` payload; in-modal refresh updates prices; Esc/backdrop closes; View still goes to kalshi.com.

---

## Phase 3 — Kalshi trading (market buy orders)

Both credentials are needed: the **API key ID** goes in the `KALSHI-ACCESS-KEY` header; the **RSA private key** signs each request.

**Create:**
- `src/lib/kalshiTrade.ts` — authenticated client against `https://api.elections.kalshi.com/trade-api/v2`:
  - Env: `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_BASE64` (base64-encoded PEM — avoids Railway newline mangling; accept raw `KALSHI_PRIVATE_KEY` fallback).
  - `signRequest(method, path)`: message = `${Date.now()}${method}${path}` (path includes `/trade-api/v2`, excludes query string); `crypto.sign("sha256", …, { padding: RSA_PKCS1_PSS_PADDING, saltLength: RSA_PSS_SALTLEN_DIGEST })` → headers `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-SIGNATURE`, `KALSHI-ACCESS-TIMESTAMP`.
  - `getBalance()` → GET `/portfolio/balance`; `createOrder()` → POST `/portfolio/orders`; `getOrder(id)`.
  - **Market-order payload:** `{ ticker, client_order_id, action: "buy", side: "yes"|"no", type: "market", count, buy_max_cost }` — set `buy_max_cost` (cents) = count × (displayed ask + 5¢ buffer) so a moved book can't overspend.
  - `getKalshiCredentials(userId?)` — env-first now, structured for a future users-table lookup (decrypt `kalshiPrivateKeyEnc`). `isTradingConfigured()` guard.
- **Schema:** `orders` table — `id PK, clientOrderId unique, userId, ticker, eventTicker, side, action, type, count, maxCostCents, avgFillPriceCents NULL, status, kalshiOrderId, response jsonb, createdAt` (+ index on eventTicker).
- **API routes (behind auth):**
  - `GET /api/portfolio/balance` → `{ balanceCents, configured }`.
  - `POST /api/orders` — validate (ticker in cached events, 1 ≤ count ≤ `MAX_ORDER_CONTRACTS` env, default 100); server-side `client_order_id = randomUUID()`; **insert `orders` row before calling Kalshi** (audit + idempotency), then update with status/kalshiOrderId/response; map Kalshi errors to friendly messages (insufficient balance, market closed). Never log the private key.
  - `GET /api/orders?eventTicker=` — local order history.
- `src/components/TradeModal.tsx` — opened from green **Buy Yes** / red **Buy No** pill buttons (showing ask price) on each `MarketsTable` row. Three steps: (1) contracts input + live math — est. cost (count × ask), max cost (with buffer), max payout (count × $1), current balance; (2) confirmation restating "Buy 10 YES @ ~37¢ — est. cost $3.70, max $4.20, payout $10.00 — REAL MONEY"; (3) success state with fill status + order id, or error with retry. Buttons disabled with tooltip when `isTradingConfigured()` is false.

**Verify:** balance renders; place a 1-contract order on a cheap liquid market; 201 from Kalshi; row in `orders` with fill; confirm `buy_max_cost` rejects an intentionally-low cap; double-submit blocked by `clientOrderId`.

---

## Phase 4 — Suggested actions (in maximized view)

**Create:**
- `src/lib/suggest.ts` (pure; shared with Phase 6):
  - `SuggestedAction { ticker, marketTitle, side, price, forecastProb, marketProb, evPerContract, kind: "consensus"|"value", rationale, liquidity }`.
  - EV(buy YES at ask) = `probability − yesAsk`; EV(buy NO at ask) = `(1 − probability) − noAsk`. Skip: 24h vol < `EDGE_MIN_VOLUME` (100), zero asks (no book), markets already decided against the side.
  - **Consensus picks:** the 3 answers closest to `prediction.forecastValue` (rank `between` buckets by |midpoint − forecastValue|; thresholds by |strike − forecastValue|). Rationale e.g. "Closest bucket to the 98°F consensus forecast."
  - **Value picks:** EV ≥ $0.05, sorted desc. Rationale e.g. "Forecast 72% vs market 55% → +17¢/contract."
  - Dedupe, cap ~5.
- `src/components/SuggestedActions.tsx` — section above the markets table in `EventDetailModal`: card per suggestion (side chip, price, EV badge, rationale) + Buy button pre-filling `TradeModal`. Empty state: "No high-confidence suggestions."

**Verify:** on a high-edge event, suggestions match the FC/MK/edge badges in the table; illiquid + decided-against markets never appear; Buy opens TradeModal prefilled.

---

## Phase 5 — Deep AI analysis improvements

**Modify only** (no schema):
- `src/app/api/analyze/route.ts` — after `getEvent` + `detectCity`, call `enrichSingleEvent(...)` and pass the full `EnrichedEvent` to `analyzeEvent`.
- `src/lib/analyze.ts` — new signature `analyzeEvent(enriched, forecast)`. Prompt additions:
  - ALL markets (cap ~25 by volume), each with yes/no **bid and ask**, last price, strike, 24h vol, plus the app's computed forecast-prob, market-prob, edge, decided flag.
  - Prediction summary: verdict, forecastValue, sigma, leadDays, modelSpread, agreement, targetDate.
  - Per-model forecast table for the target date from `byModel` (ECMWF/GFS/NBM/HRRR) + spread, and the 7-day consensus.
  - NWS `stationObs` / `observedSoFar`, labeled "official settlement-station observations — authoritative for same-day markets."
  - System prompt: "Work ONLY from the data provided. Do NOT use web search or external information." (No web-search tools are enabled anyway — cost stays input+output tokens only, ~1–3¢/call.)
  - `max_tokens` → 1500; model from env `ANALYZE_MODEL` (default `claude-sonnet-4-5`).
  - Optionally extend `AiAnalysisResult` with `suggestedMarketTicker` + `agreesWithModel`; render in `AiAnalysisModal` when present.

**Verify:** run analysis on a same-day and a 5-day-out event; dev-log the prompt to confirm byModel/stationObs/edges present; JSON still parses; log `usage` tokens to confirm cost.

---

## Phase 6 — AI Advantage page + nav rename

**Create:**
- `src/app/api/advantage/route.ts` — GET: `getOpenEventsFromDb()` → `buildEnrichedEvents()` → run `suggest.ts` EV logic across every event (uncapped) → rows `{ eventTicker, eventTitle, cityCode, marketTicker, marketTitle, side, forecastProb, price, edge, evPerContract, estProfitPer100, closeTime, volume24h, leadDays, kind }`. Filters: liquidity ≥ 100, EV ≥ $0.05, close > now. Sort EV desc (near-certain tomorrow outcomes priced low rank naturally high). Cap ~50 rows; cache in `sync_meta` key `advantage_cache` ~5 min.
- `src/app/advantage/page.tsx` — summary strip (opportunities found, best EV, events scanned, last updated) + sortable/filterable table (metric filter, min-EV, today/tomorrow) with **Buy** (prefilled `TradeModal`) and **Details** (fetch `/api/events/[ticker]` → `EventDetailModal`) per row.
- `POST /api/advantage/summary` — sends top ~15 rows to Claude (`ANALYZE_MODEL`, max_tokens ~800, no-browsing instruction) for a short narrative: best plays, why, and correlated-risk warnings (e.g. all NYC temp markets share one forecast miss). Triggered by a button, cached in `sync_meta` 30 min.

**Modify:** `Header.tsx` — nav: **Dashboard** (/), **AI Advantage** (/advantage), **Stats** (/stats), active-link highlight via `usePathname`, Logout; make `onRefresh`/`loading` optional so all pages share it (check how `stats/page.tsx` renders its header and unify).

**Verify:** recompute a few rows' EV by hand from the dashboard's FC%/price; Buy places an order; AI summary renders and is cached; empty state when nothing qualifies; warm page load fast (cache hit).

---

## New env vars (add to `.env.example`)

```
AUTH_SECRET=            # long random string (JWT signing)
ADMIN_EMAIL=
ADMIN_PASSWORD=
KALSHI_API_KEY_ID=
KALSHI_PRIVATE_KEY_BASE64=   # base64 of the RSA private key PEM
MAX_ORDER_CONTRACTS=100
ANALYZE_MODEL=claude-sonnet-4-5
```

## Phase order & dependencies

1 (auth) → 2 (maximized view) → 3 (trading; buttons live in 2's modal) → 4 (suggested actions; needs 2+3) → 5 (AI analysis; independent, anytime after 1) → 6 (advantage; needs 3+4's `suggest.ts`).

Each phase is a self-contained, verifiable chunk (~1 session each; 3 is the largest).
