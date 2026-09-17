// server/services/voice-presets-calibrate.test.ts
//
// Pure test — calibrateMaxSegmentChars never touches the DB (it takes a preset DTO and
// a probe function), so this runs under plain `pnpm test`, unlike the CRUD test in
// voice-presets.db.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { calibrateMaxSegmentChars, ensureCalibrated, withoutCalibrationFields, type PresetInput } from './voice-presets'
import { BreezeError } from '../lib/voice/breeze'
import { isCalibrated } from '../../shared/types/voice-presets'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

const clone: VoicePresetDTO = {
  id: 'p', name: 'tony', instruction: 'Warmly.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: 'k', refText: 'transcript', refDurationMs: 8000,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: false
}
const design: VoicePresetDTO = { ...clone, refStorageKey: null, refText: null, refDurationMs: null }

describe('calibrateMaxSegmentChars', () => {
  it('skips the probe entirely for a reference-free preset', async () => {
    const probe = vi.fn()
    expect(await calibrateMaxSegmentChars(design, probe)).toBe(200)
    expect(probe).not.toHaveBeenCalled()
  })

  it('returns 200 when the 200-char probe succeeds', async () => {
    const probe = vi.fn(async (_text: string) => {})
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(200)
    expect(probe).toHaveBeenCalledTimes(1)
    expect((probe.mock.calls[0]![0] as string).length).toBe(200)
  })

  it('falls back to 100 when the 200-char probe truncates', async () => {
    const probe = vi.fn(async (text: string) => {
      if (text.length > 100) throw new BreezeError('truncated', 'no audio')
    })
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(100)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('returns 100 as the floor when both probes truncate', async () => {
    const probe = vi.fn(async () => { throw new BreezeError('truncated', 'no audio') })
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(100)
  })

  // A busy rig or a network blip is not evidence about the prompt budget. Narrowing the
  // cap on it would silently degrade a good preset.
  it('rethrows a non-truncation error instead of narrowing the cap', async () => {
    const probe = vi.fn(async () => { throw new BreezeError('busy', 'in flight') })
    await expect(calibrateMaxSegmentChars(clone, probe)).rejects.toMatchObject({ code: 'busy' })
    // Review finding: asserting only the rejection's `code` left a mutation that lets
    // `busy` slip past the FIRST check invisible — it would burn a second live probe
    // (a real rig slot) before the still-correct second check caught it, and still
    // reject with the same `busy` code. Pin the call count too.
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

// ── ensureCalibrated ──────────────────────────────────────────────────────────
//
// The route-level half of calibration, tested against a fake row store so it runs in the
// plain `pnpm test` gate (DB-backed tests are excluded from CI — see vitest.config.ts).
//
// What these pin is the REVIEW FINDING: the old routes persisted the new reference first
// and compared it against the previous row's key, so a probe that threw anything other
// than `truncated` 500ed with the reference already stored — and the retry then saw
// matching keys, skipped calibration, and left a clone-backed preset on the live agent
// with a 200 cap nobody had ever measured.
describe('ensureCalibrated', () => {
  /** A one-row store standing in for the DB, so a save can be observed and re-read. */
  function store(initial: VoicePresetDTO) {
    let row = { ...initial }
    return {
      get row() { return row },
      save: vi.fn(async (id: string, input: Partial<VoicePresetDTO>) => {
        expect(id).toBe(row.id)
        row = { ...row, ...input }
        return row
      })
    }
  }

  it('measures an uncalibrated reference and records WHICH clip it measured', async () => {
    const db = store({ ...clone, calibratedRefKey: null })
    const probe = vi.fn(async (_text: string) => {})
    const { preset, calibrationWarning } = await ensureCalibrated(db.row, {
      makeProbe: async () => probe,
      save: db.save
    })
    expect(calibrationWarning).toBeNull()
    expect(preset.maxSegmentChars).toBe(200)
    expect(preset.calibratedRefKey).toBe('k')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('spends no rig slot when the cap was already measured against this clip', async () => {
    const db = store({ ...clone, calibratedRefKey: 'k' })
    const makeProbe = vi.fn()
    const { preset } = await ensureCalibrated(db.row, { makeProbe, save: db.save })
    expect(makeProbe).not.toHaveBeenCalled()
    expect(db.save).not.toHaveBeenCalled()
    expect(preset.calibratedRefKey).toBe('k')
  })

  it('re-measures when the reference clip is swapped', async () => {
    const db = store({ ...clone, refStorageKey: 'k2', calibratedRefKey: 'k' })
    const probe = vi.fn(async (text: string) => {
      if (text.length > 100) throw new BreezeError('truncated', 'no audio')
    })
    const { preset } = await ensureCalibrated(db.row, { makeProbe: async () => probe, save: db.save })
    expect(preset.maxSegmentChars).toBe(100)
    expect(preset.calibratedRefKey).toBe('k2')
  })

  // THE finding. A rig that is down (or busy, or not yet repointed) must not be able to
  // leave a preset permanently "calibrated" at a number that was never measured.
  it('retries on a LATER save after a failed probe, instead of skipping forever', async () => {
    const db = store({ ...clone, calibratedRefKey: null })

    // Save 1: the rig is down. The route still returns a saved row — with a warning.
    const down = vi.fn(async () => { throw new BreezeError('busy', 'An inference request is already running.') })
    const first = await ensureCalibrated(db.row, { makeProbe: async () => down, save: db.save })
    expect(first.calibrationWarning).toMatch(/could not be calibrated/i)
    // Uncalibrated, and provably so: the clip it carries is not the clip its cap was
    // measured against — because nothing was measured.
    expect(first.preset.calibratedRefKey).toBeNull()
    expect(isCalibrated(first.preset)).toBe(false)
    // …and it is parked at the conservative floor meanwhile, not at an assumed 200.
    expect(first.preset.maxSegmentChars).toBe(100)

    // Save 2: nothing about the reference changed — the old `key !== before.key` gate
    // would skip here, permanently. This one must probe again.
    const up = vi.fn(async (_text: string) => {})
    const second = await ensureCalibrated(db.row, { makeProbe: async () => up, save: db.save })
    expect(up).toHaveBeenCalledTimes(1)
    expect(second.calibrationWarning).toBeNull()
    expect(second.preset.maxSegmentChars).toBe(200)
    expect(second.preset.calibratedRefKey).toBe('k')
    expect(isCalibrated(second.preset)).toBe(true)
  })

  it('reports a reference clip that cannot be read the same way as a rig failure', async () => {
    const db = store({ ...clone, calibratedRefKey: null })
    const { preset, calibrationWarning } = await ensureCalibrated(db.row, {
      makeProbe: async () => { throw new Error('blob 404') },
      save: db.save
    })
    expect(calibrationWarning).toContain('blob 404')
    expect(preset.calibratedRefKey).toBeNull()
  })

  // Minor from the same review: a clone demoted back to a design preset kept the 100 cap
  // its (now removed) clip justified.
  it('resets the cap when the reference is REMOVED', async () => {
    const db = store({ ...design, maxSegmentChars: 100, calibratedRefKey: 'k' })
    const makeProbe = vi.fn()
    const { preset } = await ensureCalibrated(db.row, { makeProbe, save: db.save })
    expect(makeProbe).not.toHaveBeenCalled()
    expect(preset.maxSegmentChars).toBe(200)
    expect(preset.calibratedRefKey).toBeNull()
    expect(isCalibrated(preset)).toBe(true)
  })

  it('leaves an untouched design preset alone', async () => {
    const db = store({ ...design, calibratedRefKey: null })
    const { preset, calibrationWarning } = await ensureCalibrated(db.row, { save: db.save })
    expect(db.save).not.toHaveBeenCalled()
    expect(calibrationWarning).toBeNull()
    expect(preset.maxSegmentChars).toBe(200)
  })
})

describe('withoutCalibrationFields', () => {
  // A request body that could claim `calibratedRefKey` could claim calibration it never
  // did — which would defeat the entire distinction above.
  it('drops the measurements a request body must not be able to assert', () => {
    const cleaned = withoutCalibrationFields({
      name: 'test',
      seed: 3,
      maxSegmentChars: 4000,
      calibratedRefKey: 'k'
    })
    expect(cleaned).toEqual({ name: 'test', seed: 3 })
    expect('maxSegmentChars' in cleaned).toBe(false)
    expect('calibratedRefKey' in cleaned).toBe(false)
  })

  // `readBody` returns `undefined` for an empty PATCH body, and the route passes that
  // straight through. Destructuring `undefined` used to throw a 500 for what used to be
  // (and must again be) a harmless no-op update.
  it('does not throw on an undefined body, and returns an empty object', () => {
    expect(withoutCalibrationFields(undefined as unknown as Partial<PresetInput>)).toEqual({})
  })
})
