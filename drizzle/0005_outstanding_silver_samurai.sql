ALTER TABLE "automation_positions" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_positions" ADD COLUMN "asset" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "asset" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_snapshots" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_snapshots" ADD COLUMN "asset" text;--> statement-breakpoint
ALTER TABLE "prediction_snapshots" ADD COLUMN "tau_hours" real;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "asset" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "section" text DEFAULT 'weather' NOT NULL;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "asset" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "tau_hours" real;--> statement-breakpoint
CREATE INDEX "auto_pos_section_status_idx" ON "automation_positions" USING btree ("section","status");--> statement-breakpoint
CREATE INDEX "events_section_status_idx" ON "events" USING btree ("section","status");