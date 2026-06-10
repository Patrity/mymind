// app/composables/useVoiceSettings.ts
// User-tunable voice settings, persisted in a cookie (useCookie state is shared
// across all components reading the same key). Server-side knobs stay in
// server/lib/voice/tuning.ts; these are the client capture/playback knobs.

export interface VoiceUserSettings {
  provider: string
  voice: string
  /** Silero speech probability (0..1) above which a frame counts as speech. */
  positiveSpeechThreshold: number
  minSpeechMs: number
  redemptionMs: number
  bargeInEnabled: boolean
  playbackRate: number
}

export const VOICE_SETTINGS_DEFAULTS: VoiceUserSettings = {
  provider: 'chatterbox',
  voice: 'Gianna.wav',
  positiveSpeechThreshold: 0.5,
  minSpeechMs: 100,
  redemptionMs: 240,
  bargeInEnabled: true,
  playbackRate: 1.1,
}

/** The VAD's exit threshold trails the entry threshold (vad-web convention). */
export function negativeSpeechThreshold(positive: number): number {
  return Math.max(0.1, positive - 0.15)
}

export function useVoiceSettings() {
  const settings = useCookie<VoiceUserSettings>('voice-settings', {
    default: () => ({ ...VOICE_SETTINGS_DEFAULTS }),
    maxAge: 60 * 60 * 24 * 365,
  })
  // Older cookies may predate newly added keys — backfill from defaults once.
  settings.value = { ...VOICE_SETTINGS_DEFAULTS, ...settings.value }
  return { settings }
}
