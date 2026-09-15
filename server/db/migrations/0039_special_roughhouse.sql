CREATE TABLE "voice_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"instruction" text,
	"cfg_scale" real DEFAULT 4 NOT NULL,
	"seed" integer DEFAULT 42 NOT NULL,
	"temperature" real DEFAULT 0.9 NOT NULL,
	"top_p" real DEFAULT 1 NOT NULL,
	"top_k" integer DEFAULT 50 NOT NULL,
	"ref_storage_key" text,
	"ref_text" text,
	"ref_duration_ms" integer,
	"max_segment_chars" integer DEFAULT 200 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_presets_cfg_needs_instruction" CHECK ("voice_presets"."cfg_scale" <= 1 OR ("voice_presets"."instruction" IS NOT NULL AND btrim("voice_presets"."instruction") <> '')),
	CONSTRAINT "voice_presets_cfg_positive" CHECK ("voice_presets"."cfg_scale" > 0),
	CONSTRAINT "voice_presets_ref_needs_text" CHECK ("voice_presets"."ref_storage_key" IS NULL OR ("voice_presets"."ref_text" IS NOT NULL AND btrim("voice_presets"."ref_text") <> ''))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "voice_presets_name_key" ON "voice_presets" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_presets_one_default" ON "voice_presets" USING btree ("is_default") WHERE is_default;--> statement-breakpoint
CREATE INDEX "voice_presets_name_idx" ON "voice_presets" USING btree ("name");
--> statement-breakpoint
-- The eight starter voices from the rig's handoff package, all reference-free voice
-- design at seed 11 / cfg 4. Seeded rather than shipped as read-only built-ins so they
-- can be retuned in place; prod must deploy into a state where the agent has a voice,
-- and the cookie migration needs a valid target to point at.
INSERT INTO "voice_presets" (name, instruction, cfg_scale, seed, temperature, top_p, top_k, max_segment_chars, is_default) VALUES
  ('neutral-lowkey',  'A neutral, low-key man. Understated and unobtrusive, no performance, just clear.', 4, 11, 0.9, 1, 50, 200, true),
  ('warm-woman',      'A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.', 4, 11, 0.9, 1, 50, 200, false),
  ('bright-man',      'A bright, energetic young man. Quick, friendly, upbeat conversational pace.', 4, 11, 0.9, 1, 50, 200, false),
  ('deep-narrator',   'A deep, calm older man with measured authority. Documentary narrator gravitas.', 4, 11, 0.9, 1, 50, 200, false),
  ('crisp-anchor',    'A crisp, precise professional woman. Newsreader clarity, neutral and articulate.', 4, 11, 0.9, 1, 50, 200, false),
  ('dry-laidback',    'A laid-back American man with a dry, understated delivery and subtle humour.', 4, 11, 0.9, 1, 50, 200, false),
  ('latenight-radio', 'A gravelly, warm middle-aged man. Intimate late-night radio host, relaxed and smooth.', 4, 11, 0.9, 1, 50, 200, false),
  ('light-assistant', 'A light, upbeat woman with an approachable helpful tone. Friendly assistant energy.', 4, 11, 0.9, 1, 50, 200, false);