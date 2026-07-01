// server/lib/voice/tuning.ts
// Single source of voice-loop tuning. Adjust freely — no rebuild-to-tune.
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'kokoro' as 'chatterbox' | 'kokoro', sentenceMinChars: 60, playbackRate: 1.1 },
  stt:     { language: 'en' },
  // maxSteps: default cap for chat turns — 6 forced a real web-research turn to stop
  // mid-investigation and rationalize ("I have enough context"); 12 gives search→fetch→
  // cross-check headroom. maxStepsPowerful: exec-enabled runs do multi-step work
  // (install → configure → run → verify), so they need more (a 6-step cap stranded a
  // real gh install+run mid-task).
  // temperature: ALWAYS sent explicitly — if the serving stack defaults to greedy
  // decoding, a small local model degenerates into verbatim copy-loops of its own
  // history (qwen3 recommended sampling: temp 0.7).
  agent:   { maxSteps: 12, maxStepsPowerful: 16, temperature: 0.7 }
}
export type VoiceTuning = typeof VOICE_TUNING
