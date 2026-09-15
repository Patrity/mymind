// server/lib/voice/tuning.ts
// Server-side voice-loop tuning that is actually read at runtime. Adjust freely
// within these four groups — no rebuild-to-tune — but a new group here is dead on
// arrival unless something imports VOICE_TUNING and reads it: this file only
// DEFINES the values, it doesn't wire them anywhere, and typecheck can't catch an
// unread field because this same file also declares the type. Grep for
// `VOICE_TUNING.<group>` before trusting a group is live.
//
// vad/turn/bargeIn previously lived here but had zero readers at the base commit
// (before this file's own history began) — VAD tuning (positiveSpeechThreshold,
// etc.) is a client-side, per-user, cookie-backed preference in
// app/composables/useVoiceSettings.ts, and barge-in fires unconditionally off the
// client VAD's speech-start event (see useVoice.ts), never consulting a
// server-side threshold. Removed rather than left to look authoritative. Same
// defect class as the `playbackRate` copy removed from this file earlier on this
// branch, and as `tts.provider` below.
export const VOICE_TUNING = {
  // sentenceMinChars: the old 60 cut mid-clause, and each cut is a separate TTS call
  // with a seam and a round-trip. 140 with a clause-aware break (see segment.ts).
  // sentenceMaxChars: a HARD cap (repeatable within a single segment() call, unlike
  // the one-shot sentenceMinChars fallback) — without it a long sentence with no
  // clause boundary until its terminal punctuation can grow arbitrarily long, and on
  // a slow autoregressive engine (~0.067s/char on Orpheus) a 400-char segment is a
  // ~27s stall before a single sample plays.
  // firstSegmentMaxChars: the FIRST segment of a turn only, deliberately short — time
  // to first audio is dominated by the first segment's length, so keep it small even
  // though later segments are allowed to run longer (short segments are actually LESS
  // efficient for autoregressive engines once already warmed up).
  // pipelineConcurrency: PINNED AT 1. Breeze serves one inference at a time (409
  // otherwise), and pipeline.ts now emits chunks as they arrive rather than buffering a
  // whole segment — so >1 in flight would both 409 the rig and interleave two segments'
  // audio. SpeechPipeline throws if this is ever raised.
  // playbackRate lives client-side (app/composables/useVoiceSettings.ts default 1.0,
  // user-adjustable in the settings slideover) — it's a per-user preference, not a
  // server tuning knob, so it doesn't belong here. A copy here previously went stale
  // (changed to 1.0 with no reader) while the real default stayed at 1.1.
  //
  // NOTE: voice selection is NOT here either — a voice is a PRESET row now
  // (shared/types/voice-presets.ts), resolved per turn at the WS boundary from the
  // client's cookie-backed preset id. sentenceMaxChars is further clamped per preset by
  // that preset's calibrated maxSegmentChars (see orchestrator.ts).
  tts:     { sentenceMinChars: 140, sentenceMaxChars: 200, firstSegmentMaxChars: 60, pipelineConcurrency: 1 },
  stt:     { language: 'en' },
  // maxSteps: one cap for every main-loop turn — the agent is always fully armed
  // (the old 6-step quick cap forced research turns to stop mid-investigation, and
  // a 6-step cap once stranded a real gh install+run mid-task). Subagents pass
  // their own ctx.maxSteps override.
  // temperature: ALWAYS sent explicitly — if the serving stack defaults to greedy
  // decoding, a small local model degenerates into verbatim copy-loops of its own
  // history (qwen3 recommended sampling: temp 0.7).
  agent:   { maxSteps: 16, temperature: 0.7 }
}
export type VoiceTuning = typeof VOICE_TUNING
