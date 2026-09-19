// app/composables/useVoiceSettings.ts
// User-tunable voice settings, persisted in a cookie (useCookie state is shared
// across all components reading the same key). Server-side knobs stay in
// server/lib/voice/tuning.ts; these are the client capture/playback knobs.

import { personaVariant } from '~/lib/agent/persona'
import type { PersonaVariant } from '~/lib/agent/persona'

export interface VoiceUserSettings {
  /** voice_presets.id. '' means "use the server's default preset" — which is also what
   *  an unknown id resolves to (resolvePreset), so a deleted preset degrades gracefully. */
  presetId: string
  /** Silero speech probability (0..1) above which a frame counts as speech. */
  positiveSpeechThreshold: number
  minSpeechMs: number
  redemptionMs: number
  bargeInEnabled: boolean
  playbackRate: number
  /** enumerateDevices() deviceId to constrain getUserMedia to. '' = system default
   *  (no constraint) — the OS/browser picks, which is what shipped before this setting
   *  existed. See useVoice's getUserMedia call for the `exact` constraint + the
   *  OverconstrainedError fallback when a chosen device has since vanished. */
  micDeviceId: string
  /** Persona character variant. */
  personaVariant: PersonaVariant
}

export const VOICE_SETTINGS_DEFAULTS: VoiceUserSettings = {
  presetId: '',
  positiveSpeechThreshold: 0.5,
  minSpeechMs: 100,
  redemptionMs: 240,
  bargeInEnabled: true,
  playbackRate: 1.0,
  micDeviceId: '',
  personaVariant: 'obsidian',
}

/** playbackRate defaulted to 1.1 before it was found to compress the model's prosody and
 *  read as rushed (see server/lib/voice/tuning.ts history). Cookies written under that
 *  default still carry 1.1 forever unless corrected here — nobody chose 1.1 on purpose,
 *  it was just what new sessions got. Any other value is a deliberate user choice and is
 *  left untouched. */
const OLD_DEFAULT_PLAYBACK_RATE = 1.1

/** Pure merge/migration step, split out from useVoiceSettings so it can be unit-tested
 *  without a Nuxt useCookie context. */
export function migrateVoiceSettings(stored: Partial<VoiceUserSettings> | null | undefined): VoiceUserSettings {
  // Older cookies may predate newly added keys — backfill from defaults.
  const merged = { ...VOICE_SETTINGS_DEFAULTS, ...stored } as VoiceUserSettings & { provider?: string; voice?: string }
  // Pre-Breeze cookies carry {provider, voice} naming a Kokoro/Chatterbox voice that no
  // longer exists on any engine. Drop them; '' resolves to the server's default preset.
  if ('provider' in merged || 'voice' in merged) {
    delete merged.provider
    delete merged.voice
    if (!merged.presetId) merged.presetId = ''
  }
  if (merged.playbackRate === OLD_DEFAULT_PLAYBACK_RATE) {
    merged.playbackRate = VOICE_SETTINGS_DEFAULTS.playbackRate
  }
  // Normalize personaVariant: unknown values default to 'obsidian'
  merged.personaVariant = personaVariant(merged.personaVariant)
  return merged
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
  settings.value = migrateVoiceSettings(settings.value)
  return { settings }
}
