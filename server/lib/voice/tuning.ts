// server/lib/voice/tuning.ts
// Single source of voice-loop tuning. Adjust freely — no rebuild-to-tune.
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'kokoro' as 'chatterbox' | 'kokoro', sentenceMinChars: 60, playbackRate: 1.1 },
  stt:     { language: 'en' },
  agent:   { maxSteps: 6 }
}
export type VoiceTuning = typeof VOICE_TUNING
