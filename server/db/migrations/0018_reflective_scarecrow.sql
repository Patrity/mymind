CREATE TABLE "memory_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" text NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
CREATE INDEX "memory_relations_from_idx" ON "memory_relations" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "memory_relations_to_idx" ON "memory_relations" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "memory_relations_type_idx" ON "memory_relations" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_relations_edge_uidx" ON "memory_relations" USING btree ("from_id","to_id","type");