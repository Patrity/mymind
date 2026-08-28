// app/composables/useVoiceSettings.test.ts
import { describe, it, expect } from 'vitest'
import { VOICE_SETTINGS_DEFAULTS, migrateVoiceSettings } from './useVoiceSettings'

describe('useVoiceSettings defaults + migration', () => {
  it('defaults playbackRate to 1.0 (not the old 1.1 rushed-audio default)', () => {
    expect(VOICE_SETTINGS_DEFAULTS.playbackRate).toBe(1.0)
  })

  it('a fresh session (no stored cookie) gets playbackRate 1.0', () => {
    const settings = migrateVoiceSettings(undefined)
    expect(settings.playbackRate).toBe(1.0)
  })

  it('migrates a cookie carrying the old 1.1 default forward to 1.0', () => {
    const stored = { ...VOICE_SETTINGS_DEFAULTS, playbackRate: 1.1 }
    const settings = migrateVoiceSettings(stored)
    expect(settings.playbackRate).toBe(1.0)
  })

  it('does not clobber other settings while migrating playbackRate', () => {
    const stored = { ...VOICE_SETTINGS_DEFAULTS, playbackRate: 1.1, voice: 'Custom.wav', minSpeechMs: 250 }
    const settings = migrateVoiceSettings(stored)
    expect(settings.playbackRate).toBe(1.0)
    expect(settings.voice).toBe('Custom.wav')
    expect(settings.minSpeechMs).toBe(250)
  })

  it('leaves a genuinely customised playbackRate (not the old default) untouched', () => {
    const stored = { ...VOICE_SETTINGS_DEFAULTS, playbackRate: 1.25 }
    const settings = migrateVoiceSettings(stored)
    expect(settings.playbackRate).toBe(1.25)
  })

  it('backfills missing keys from defaults for a cookie predating them', () => {
    const stored = { playbackRate: 1.25 } as Partial<typeof VOICE_SETTINGS_DEFAULTS>
    const settings = migrateVoiceSettings(stored)
    expect(settings.provider).toBe(VOICE_SETTINGS_DEFAULTS.provider)
    expect(settings.playbackRate).toBe(1.25)
  })
})
