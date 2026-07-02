CREATE TABLE "events" (
	"event_ticker" text PRIMARY KEY NOT NULL,
	"series_ticker" text NOT NULL,
	"title" text NOT NULL,
	"sub_title" text,
	"category" text,
	"strike_date" text,
	"city_code" text,
	"status" text DEFAULT 'open' NOT NULL,
	"data" jsonb NOT NULL,
	"earliest_close" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
