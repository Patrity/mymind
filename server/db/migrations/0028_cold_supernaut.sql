CREATE TABLE "graph_layout" (
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"z" real NOT NULL,
	"degree" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_layout_source_type_source_id_pk" PRIMARY KEY("source_type","source_id")
);
--> statement-breakpoint
CREATE INDEX "graph_layout_type_idx" ON "graph_layout" USING btree ("source_type");