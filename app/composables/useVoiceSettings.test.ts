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
    const stored = { ...VOICE_SETTINGS_DEFAULTS, playbackRate: 1.1, presetId: 'warm-narrator', minSpeechMs: 250 }
    const settings = migrateVoiceSettings(stored)
    expect(settings.playbackRate).toBe(1.0)
    expect(settings.presetId).toBe('warm-narrator')
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
    expect(settings.presetId).toBe(VOICE_SETTINGS_DEFAULTS.presetId)
    expect(settings.micDeviceId).toBe(VOICE_SETTINGS_DEFAULTS.micDeviceId)
    expect(settings.playbackRate).toBe(1.25)
  })
})

describe('migrateVoiceSettings — Breeze preset migration', () => {
  it('drops a pre-Breeze provider/voice pair and falls back to the default preset', () => {
    const out = migrateVoiceSettings({ provider: 'chatterbox', voice: 'Gianna.wav' } as never)
    expect(out.presetId).toBe('')
    expect('provider' in out).toBe(false)
    expect('voice' in out).toBe(false)
  })

  it('keeps an already-migrated presetId', () => {
    const out = migrateVoiceSettings({ presetId: 'abc-123' } as never)
    expect(out.presetId).toBe('abc-123')
  })

  it('backfills newly added keys from defaults', () => {
    const out = migrateVoiceSettings({ presetId: 'x' } as never)
    expect(out.playbackRate).toBe(VOICE_SETTINGS_DEFAULTS.playbackRate)
    expect(out.bargeInEnabled).toBe(VOICE_SETTINGS_DEFAULTS.bargeInEnabled)
  })
})

describe('migrateVoiceSettings — personaVariant', () => {
  it('personaVariant defaults to obsidian and unknown values are normalized', () => {
    expect(migrateVoiceSettings({}).personaVariant).toBe('obsidian')
    expect(migrateVoiceSettings({ personaVariant: 'glint' } as never).personaVariant).toBe('glint')
    expect(migrateVoiceSettings({ personaVariant: 'bogus' } as never).personaVariant).toBe('obsidian')
  })
})
