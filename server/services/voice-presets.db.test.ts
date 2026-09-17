// server/services/voice-presets.db.test.ts
//
// DB-backed test — see test/documents-content-hash.db.test.ts for the harness pattern this
// file follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// beforeEach scope: CONTROLLER RULING R1 overrides the brief's original
// `delete(...).where(ne(voicePresets.name, 'neutral-lowkey'))` — that blanket delete would
// permanently destroy 7 of the 8 seeded presets (migration 0039 has already run and will not
// re-seed), and a later task asserts all eight are listed. Every fixture this file creates is
// named `test-...`, so scoping the delete to that prefix is complete cleanup with no blast
// radius on the seed data.
process.loadEnvFile('.env')
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../db'
import { voicePresets } from '../db/schema'
import { eq, like } from 'drizzle-orm'
import { createPreset, updatePreset, deletePreset, getDefaultPreset, getPreset, resolvePreset, listPresets, ensureCalibrated } from './voice-presets'
import { isCalibrated } from '../../shared/types/voice-presets'

describe('voice-presets service', () => {
  beforeEach(async () => {
    // Scoped to this file's own fixtures. A blanket delete would destroy the seeded
    // presets permanently: the migration has already run and will not re-seed.
    await useDb().delete(voicePresets).where(like(voicePresets.name, 'test-%'))
  })

  it('lists the seeded default', async () => {
    const d = await getDefaultPreset()
    expect(d.name).toBe('neutral-lowkey')
    expect(d.maxSegmentChars).toBe(200)
  })

  it('creates a design preset', async () => {
    const p = await createPreset({ name: 'test-design', instruction: 'A calm man.', cfgScale: 4, seed: 7 })
    expect(p.instruction).toBe('A calm man.')
    expect(p.isDefault).toBe(false)
    expect((await listPresets()).some(x => x.id === p.id)).toBe(true)
  })

  it('moves the default rather than creating a second one', async () => {
    // This suite runs against the real dev DB (no seed re-run), and the next test's
    // beforeEach deletes every `test-%` row including whichever one now holds
    // is_default — restore the original default in `finally` so that delete doesn't
    // leave the table (and the live app) with zero default presets. The createPreset
    // call itself sits inside the try: clearOtherDefaults() already ran (demoting
    // `original`) by the time createPreset's insert executes, so if that insert throws,
    // the finally must still run to restore the default — leaving it outside the try
    // would skip the restore on exactly the failure path R1 exists to guard against.
    const original = await getDefaultPreset()
    try {
      const p = await createPreset({ name: 'test-default', instruction: 'A calm man.', isDefault: true })
      expect((await getDefaultPreset()).id).toBe(p.id)
      const defaults = await useDb().select().from(voicePresets).where(eq(voicePresets.isDefault, true))
      expect(defaults).toHaveLength(1)
    } finally {
      await updatePreset(original.id, { isDefault: true })
    }
  })

  it('resolvePreset falls back to the default for an unknown id', async () => {
    const d = await getDefaultPreset()
    expect((await resolvePreset('00000000-0000-0000-0000-000000000000')).id).toBe(d.id)
    expect((await resolvePreset(null)).id).toBe(d.id)
  })

  // Review finding (Critical): the id comes from an untrusted browser cookie — a
  // hand-edited, truncated, or stale-build value can be any string, not just a
  // well-formed-but-missing UUID. Postgres throws `invalid input syntax for type uuid`
  // on a non-UUID literal; that must degrade to the default like any other bad id, not
  // fail the turn.
  it('resolvePreset falls back to the default for a malformed (non-UUID) id', async () => {
    const d = await getDefaultPreset()
    expect((await resolvePreset('not-a-uuid')).id).toBe(d.id)
  })

  it('refuses to delete the default', async () => {
    const d = await getDefaultPreset()
    await expect(deletePreset(d.id)).rejects.toThrow(/default/)
  })

  it('rejects cfg_scale > 1 without an instruction at the DB level', async () => {
    await expect(createPreset({ name: 'test-bad', cfgScale: 4 })).rejects.toThrow()
  })

  it('rejects a reference without its transcript at the DB level', async () => {
    await expect(createPreset({ name: 'test-bad-ref', cfgScale: 1, refStorageKey: 'k' })).rejects.toThrow()
  })

  it('updates a preset', async () => {
    const p = await createPreset({ name: 'test-upd', instruction: 'A calm man.' })
    const u = await updatePreset(p.id, { seed: 999 })
    expect(u.seed).toBe(999)
  })

  // The column behind the "was this cap ever actually measured?" distinction. A new row
  // must start uncalibrated no matter what its cap column happens to default to.
  it('creates reference-backed rows UNCALIBRATED, and round-trips the marker', async () => {
    const p = await createPreset({
      name: 'test-clone', cfgScale: 1, refStorageKey: 'blob/clip', refText: 'the transcript',
      // The clip's provenance travels with it — voice_presets_ref_source_pairs_with_clip.
      refSource: 'upload'
    })
    expect(p.calibratedRefKey).toBeNull()
    expect(p.maxSegmentChars).toBe(200)
    expect(isCalibrated(p)).toBe(false)

    const measured = await updatePreset(p.id, { maxSegmentChars: 100, calibratedRefKey: 'blob/clip' })
    expect(isCalibrated(measured)).toBe(true)
    expect((await getPreset(p.id))?.calibratedRefKey).toBe('blob/clip')

    // Demote it to a design preset: the cap its clip justified goes with the clip, and so
    // does its source.
    const demoted = await updatePreset(p.id, { refStorageKey: null, refText: null, refSource: null })
    const { preset: reset } = await ensureCalibrated(demoted)
    expect(reset.maxSegmentChars).toBe(200)
    expect(reset.calibratedRefKey).toBeNull()
  })
})

// ── The clip/source pair is enforced by the database ──────────────────────────
//
// `ref_source` was written only by the lock/unlock routes while the clip fields were written
// only by Save, so both illegal halves were reachable and both shipped. The client now writes
// the tuple as one unit (studio.ts ReferenceFields); these tests pin the BACKSTOP, so a future
// writer that forgets cannot quietly reintroduce either shape.
describe('voice_presets_ref_source_pairs_with_clip', () => {
  beforeEach(async () => {
    await useDb().delete(voicePresets).where(like(voicePresets.name, 'test-%'))
  })

  /** The constraint NAME, not the message. Drizzle's thrown Error is the whole failed query
   *  with its parameters interpolated; the useful identifier is on the pg error underneath,
   *  and asserting it is what makes these tests name the specific rule that fired rather
   *  than merely "the write was rejected". */
  async function violates(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn()
    } catch (e) {
      const cause = (e as { cause?: { constraint?: string } }).cause
      return cause?.constraint ?? `no constraint on: ${(e as Error).message.slice(0, 80)}`
    }
    throw new Error('expected a constraint violation, but the write succeeded')
  }

  it('refuses a clip with no recorded source', async () => {
    expect(await violates(() => createPreset({
      name: 'test-clip-no-source', instruction: 'A calm man.', cfgScale: 4,
      refStorageKey: 'k', refText: 'a transcript'
    }))).toBe('voice_presets_ref_source_pairs_with_clip')
  })

  it('refuses a source with no clip', async () => {
    expect(await violates(() => createPreset({
      name: 'test-source-no-clip', instruction: 'A calm man.', cfgScale: 4,
      refSource: 'locked'
    }))).toBe('voice_presets_ref_source_pairs_with_clip')
  })

  it('refuses a source the synthesis path does not know how to speak', async () => {
    expect(await violates(() => createPreset({
      name: 'test-bogus-source', instruction: 'A calm man.', cfgScale: 4,
      refStorageKey: 'k', refText: 'a transcript',
      refSource: 'imported' as 'upload'
    }))).toBe('voice_presets_ref_source_known')
  })

  it('accepts the two legal pairs', async () => {
    const up = await createPreset({
      name: 'test-pair-upload', instruction: 'A calm man.', cfgScale: 4,
      refStorageKey: 'k1', refText: 'a transcript', refSource: 'upload'
    })
    expect(up.refSource).toBe('upload')
    const lk = await createPreset({
      name: 'test-pair-locked', instruction: 'A calm man.', cfgScale: 4,
      refStorageKey: 'k2', refText: 'a transcript', refSource: 'locked'
    })
    expect(lk.refSource).toBe('locked')
  })

  // Duplicate copies the clip; before this, createPreset's explicit allow-list dropped the
  // source and the copy became a clip with no provenance.
  it('carries the source through a duplicate-shaped create', async () => {
    const copy = await createPreset({
      name: 'test-dup-locked', instruction: 'A calm man.', cfgScale: 4,
      refStorageKey: 'k4', refText: 'a transcript', refSource: 'locked',
      starredSeeds: [7, 11]
    })
    expect(copy.refSource).toBe('locked')
    // Same allow-list, same omission: a duplicated voice used to lose its kept seeds.
    expect(copy.starredSeeds).toEqual([7, 11])
  })

  // Clearing a clip has to clear its source in the same statement — the shape that left the
  // studio reporting a locked voice with nothing frozen.
  it('refuses to clear the clip while leaving the source behind', async () => {
    const p = await createPreset({
      name: 'test-clear-half', instruction: 'A calm man.', cfgScale: 4,
      refStorageKey: 'k3', refText: 'a transcript', refSource: 'locked'
    })
    expect(await violates(() => updatePreset(p.id, { refStorageKey: null, refText: null })))
      .toBe('voice_presets_ref_source_pairs_with_clip')
    const cleared = await updatePreset(p.id, {
      refStorageKey: null, refText: null, refDurationMs: null, refSource: null
    })
    expect(cleared.refSource).toBeNull()
  })
})
