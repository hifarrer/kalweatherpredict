CREATE TABLE "prediction_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_ticker" text NOT NULL,
	"market_ticker" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_date" text,
	"city_code" text,
	"metric" text NOT NULL,
	"lead_days" integer,
	"forecast_value" real,
	"sigma" real,
	"model_spread" real,
	"predicted_prob" real NOT NULL,
	"market_prob" real,
	"is_final" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"market_ticker" text PRIMARY KEY NOT NULL,
	"event_ticker" text NOT NULL,
	"city_code" text,
	"metric" text,
	"target_date" text,
	"result" text NOT NULL,
	"actual_value" real,
	"strike_type" text,
	"floor_strike" real,
	"cap_strike" real,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "snap_market_captured_idx" ON "prediction_snapshots" USING btree ("market_ticker","captured_at");--> statement-breakpoint
CREATE INDEX "snap_target_date_idx" ON "prediction_snapshots" USING btree ("target_date");--> statement-breakpoint
CREATE INDEX "settlements_event_idx" ON "settlements" USING btree ("event_ticker");