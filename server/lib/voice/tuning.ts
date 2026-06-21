// server/lib/voice/tuning.ts
// Single source of voice-loop tuning. Adjust freely — no rebuild-to-tune.
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'kokoro' as 'chatterbox' | 'kokoro', sentenceMinChars: 60, playbackRate: 1.1 },
  stt:     { language: 'en' },
  // maxSteps: default cap for quick voice/chat turns. maxStepsPowerful: exec-enabled runs do
  // multi-step work (install → configure → run → verify), so they need more headroom (a 6-step
  // cap stranded a real gh install+run mid-task).
  agent:   { maxSteps: 6, maxStepsPowerful: 16 }
}
export type VoiceTuning = typeof VOICE_TUNING
