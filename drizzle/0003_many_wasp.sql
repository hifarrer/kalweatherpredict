CREATE TABLE "suggestions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_ticker" text NOT NULL,
	"market_ticker" text NOT NULL,
	"side" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"price" real NOT NULL,
	"forecast_prob" real NOT NULL,
	"blended_prob" real NOT NULL,
	"win_prob" real NOT NULL,
	"market_prob" real,
	"fee_per_contract" real NOT NULL,
	"ev_per_contract" real NOT NULL,
	"score" real NOT NULL,
	"volume_24h" real,
	"city_code" text,
	"metric" text,
	"target_date" text,
	"lead_days" integer,
	"ai_verdict" text,
	"ai_confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text,
	"suggested_side_won" boolean,
	"realized_ev" real,
	"graded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fill_count" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "avg_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "suggestion_id" bigint;--> statement-breakpoint
CREATE INDEX "suggestions_market_idx" ON "suggestions" USING btree ("market_ticker");--> statement-breakpoint
CREATE INDEX "suggestions_graded_idx" ON "suggestions" USING btree ("graded_at");--> statement-breakpoint
CREATE INDEX "suggestions_created_idx" ON "suggestions" USING btree ("created_at");--> statement-breakpoint
UPDATE "orders" SET
	"fill_count" = CASE
		WHEN jsonb_typeof("response") = 'object' AND "response" ? 'fill_count'
			THEN ROUND(("response"->>'fill_count')::numeric)::int
		WHEN "status" = 'executed' THEN "count"
		ELSE NULL END,
	"avg_fee_cents" = CASE
		WHEN jsonb_typeof("response") = 'object' AND "response" ? 'average_fee_paid'
			THEN ROUND(("response"->>'average_fee_paid')::numeric * 100)::int
		ELSE NULL END
WHERE "fill_count" IS NULL;