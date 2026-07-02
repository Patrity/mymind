// server/lib/voice/tuning.ts
// Single source of voice-loop tuning. Adjust freely — no rebuild-to-tune.
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'kokoro' as 'chatterbox' | 'kokoro', sentenceMinChars: 60, playbackRate: 1.1 },
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
