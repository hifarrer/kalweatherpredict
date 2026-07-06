CREATE TABLE "automation_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"ticker" text,
	"event_ticker" text,
	"side" text,
	"count" integer,
	"price_cents" integer,
	"reason" text NOT NULL,
	"order_id" bigint,
	"position_id" bigint,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"event_ticker" text NOT NULL,
	"side" text NOT NULL,
	"count" integer NOT NULL,
	"avg_cost_cents" integer NOT NULL,
	"buy_fee_cents" integer,
	"open_order_id" bigint,
	"suggestion_id" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"city_code" text,
	"metric" text,
	"target_date" text,
	"exit_reason" text,
	"sell_order_id" bigint,
	"sale_proceeds_cents" integer,
	"sell_fee_cents" integer,
	"realized_pnl_cents" integer,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trigger" text DEFAULT 'cron' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"balance_cents" integer,
	"deployed_cents" integer,
	"candidates" integer,
	"buys" integer,
	"sells" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE INDEX "auto_actions_run_idx" ON "automation_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "auto_pos_status_idx" ON "automation_positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "auto_pos_ticker_idx" ON "automation_positions" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "auto_runs_started_idx" ON "automation_runs" USING btree ("started_at");