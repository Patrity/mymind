CREATE TABLE "clip_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text,
	"size" integer DEFAULT 0 NOT NULL,
	"mime" text,
	"original_name" text,
	"width" integer,
	"height" integer
);
--> statement-breakpoint
CREATE TABLE "clip_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"device_id" uuid,
	"kind" text DEFAULT 'text' NOT NULL,
	"body_text" text,
	"body_html" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"title" text DEFAULT 'Clipboard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "clip_messages_thread_idx" ON "clip_messages" USING btree ("thread_id","created_at");