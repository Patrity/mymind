CREATE TABLE "model_prices" (
	"model" text PRIMARY KEY NOT NULL,
	"input_cost_per_token" numeric NOT NULL,
	"output_cost_per_token" numeric NOT NULL,
	"cache_read_cost_per_token" numeric NOT NULL,
	"cache_creation_cost_per_token" numeric NOT NULL,
	"cache_creation_above_1h_cost_per_token" numeric NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "litellm_daily" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"spend" numeric DEFAULT '0' NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "litellm_daily_day_model_pk" PRIMARY KEY("day","model")
);
