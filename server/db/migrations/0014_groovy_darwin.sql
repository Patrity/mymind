CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"usage" text,
	"provider" text,
	"model_id" text,
	"attempt" integer,
	"duration_ms" integer,
	"tokens" jsonb,
	"request" jsonb,
	"response" jsonb,
	"error" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_trace_idx" ON "activity_log" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "activity_kind_idx" ON "activity_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "activity_severity_idx" ON "activity_log" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_unacked_error_idx" ON "activity_log" USING btree ("acked_at") WHERE "status" = 'error' AND "acked_at" IS NULL;