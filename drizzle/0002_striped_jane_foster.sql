CREATE TABLE "orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_order_id" text NOT NULL,
	"user_id" integer,
	"ticker" text NOT NULL,
	"event_ticker" text NOT NULL,
	"side" text NOT NULL,
	"action" text DEFAULT 'buy' NOT NULL,
	"type" text DEFAULT 'market' NOT NULL,
	"count" integer NOT NULL,
	"max_cost_cents" integer,
	"avg_fill_price_cents" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"kalshi_order_id" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_client_order_id_unique" UNIQUE("client_order_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"kalshi_api_key_id" text,
	"kalshi_private_key_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "orders_event_idx" ON "orders" USING btree ("event_ticker");