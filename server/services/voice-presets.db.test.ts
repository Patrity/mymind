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
import { createPreset, updatePreset, deletePreset, getDefaultPreset, resolvePreset, listPresets } from './voice-presets'

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
    // leave the table (and the live app) with zero default presets.
    const original = await getDefaultPreset()
    const p = await createPreset({ name: 'test-default', instruction: 'A calm man.', isDefault: true })
    try {
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
})
