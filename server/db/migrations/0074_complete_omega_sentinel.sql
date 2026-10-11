CREATE TABLE "workspace_shells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"command" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"reason" text,
	"read_offset" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workstream_id" uuid,
	"conversation_id" uuid,
	"command" text NOT NULL,
	"until" jsonb NOT NULL,
	"interval_sec" integer NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'armed' NOT NULL,
	"polls" integer DEFAULT 0 NOT NULL,
	"last_exit_code" integer,
	"last_output" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_shells" ADD CONSTRAINT "workspace_shells_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_watches" ADD CONSTRAINT "workspace_watches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_shells_ws_idx" ON "workspace_shells" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "workspace_watches_state_idx" ON "workspace_watches" USING btree ("state");--> statement-breakpoint
CREATE INDEX "workspace_watches_ws_idx" ON "workspace_watches" USING btree ("workspace_id","state");