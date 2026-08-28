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
  // playbackRate lives client-side (app/composables/useVoiceSettings.ts default 1.0,
  // user-adjustable in the settings slideover) — it's a per-user preference, not a
  // server tuning knob, so it doesn't belong here. A copy here previously went stale
  // (changed to 1.0 with no reader) while the real default stayed at 1.1.
  //
  // NOTE: provider selection is NOT here — it's `deps.ttsProvider`, threaded through
  // from the client's cookie-backed VOICE_SETTINGS_DEFAULTS.provider (currently
  // 'chatterbox'; see useVoiceSettings.ts). A `provider: 'kokoro'` copy lived here
  // with zero readers and had drifted out of sync with the real default — removed.
  tts:     { sentenceMinChars: 140 },
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
