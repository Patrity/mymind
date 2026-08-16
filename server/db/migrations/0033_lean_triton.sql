CREATE TABLE "triage_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"confidence" real NOT NULL,
	"auto_applied" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "triage_actions_created_at_idx" ON "triage_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "triage_actions_doc_idx" ON "triage_actions" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "documents_triaged_at_idx" ON "documents" USING btree ("triaged_at");