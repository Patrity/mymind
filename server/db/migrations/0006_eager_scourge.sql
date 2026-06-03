CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text,
	"mime" text NOT NULL,
	"ext" text NOT NULL,
	"kind" text DEFAULT 'image' NOT NULL,
	"width" integer,
	"height" integer,
	"size" integer NOT NULL,
	"ocr_text" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"recommended_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"public_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "images_public_slug_uidx" ON "images" USING btree ("public_slug");--> statement-breakpoint
CREATE INDEX "images_tags_gin" ON "images" USING gin ("tags");