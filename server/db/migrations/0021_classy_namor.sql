ALTER TABLE "documents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE INDEX "documents_project_id_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
UPDATE documents d SET project_id = p.id FROM projects p WHERE d.project = p.slug AND d.project_id IS NULL;