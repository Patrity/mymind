CREATE TABLE "workstream_question_tags" (
	"tag" integer PRIMARY KEY NOT NULL,
	"workstream_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
