CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"only_sink" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"boot_id" text PRIMARY KEY NOT NULL,
	"pid" integer,
	"host" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "run_events_conv_id_idx" ON "run_events" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "worker_commands_pending_idx" ON "worker_commands" USING btree ("id") WHERE handled_at is null and claimed_at is null;--> statement-breakpoint
CREATE INDEX "worker_heartbeat_beat_idx" ON "worker_heartbeat" USING btree ("beat_at");