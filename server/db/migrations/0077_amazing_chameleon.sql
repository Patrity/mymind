ALTER TABLE "workstreams" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "model_label" text;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "workspace_mode" text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "tree_budget" jsonb;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "tree_used" jsonb;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "tainted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_parent_id_workstreams_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."workstreams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workstreams_parent_idx" ON "workstreams" USING btree ("parent_id");