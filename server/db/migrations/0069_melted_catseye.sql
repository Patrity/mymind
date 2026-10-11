DROP INDEX "worker_heartbeat_beat_idx";--> statement-breakpoint
DROP INDEX "run_events_conv_id_idx";--> statement-breakpoint
DROP INDEX "worker_commands_pending_idx";--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "ns" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_commands" ADD COLUMN "ns" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_heartbeat" ADD COLUMN "ns" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "worker_heartbeat_ns_beat_idx" ON "worker_heartbeat" USING btree ("ns","beat_at");--> statement-breakpoint
CREATE INDEX "run_events_conv_id_idx" ON "run_events" USING btree ("ns","conversation_id","id");--> statement-breakpoint
CREATE INDEX "worker_commands_pending_idx" ON "worker_commands" USING btree ("ns","id") WHERE handled_at is null and claimed_at is null;