CREATE TABLE "exec_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pattern" text NOT NULL,
	"tool" text DEFAULT 'exec' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exec_approvals_tool_pattern_idx" ON "exec_approvals" USING btree ("tool","pattern");