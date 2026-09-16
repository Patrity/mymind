// server/api/voice/speak-overrides.db.test.ts
//
// The non-persistence proof. Everything else about overrides can be asserted in-process,
// but "an audition never writes" is a claim about the DATABASE, so it is made against a
// real one. Follows the harness in server/services/voice-presets.db.test.ts (`.env` load +
// `useRuntimeConfig` stub so `useDb()` works outside Nuxt); run with `pnpm test:db`,
// excluded from the CI gate, which has no Postgres.
//
// Fixtures are all named `test-...` and the cleanup is scoped to that prefix — a blanket
// delete would permanently destroy the seven seeded presets (migration 0039 has already
// run and will not re-seed).
process.loadEnvFile('.env')
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../../db'
import { voicePresets } from '../../db/schema'
import { like } from 'drizzle-orm'
import { createPreset, deletePreset, getPreset, resolvePreset, updatePreset } from '../../services/voice-presets'
import { applyOverrides, presetToRequest } from '../../lib/voice/speak'
import { validateBreezeRequest } from '../../lib/voice/breeze'

/**
 * Everything POST /api/voice/speak does to a preset before it reaches the queue. The rig
 * call itself is the only step omitted — it consumes the returned request and cannot
 * write to the database.
 */
async function speakPreflight(presetId: string, overrides: Parameters<typeof applyOverrides>[1], text = 'A short line to render.') {
  const stored = await resolvePreset(presetId)
  const preset = applyOverrides(stored, overrides)
  const refAudio = null // no reference on these fixtures
  return { request: presetToRequest(text, preset, refAudio), invalid: validateBreezeRequest(presetToRequest(text, preset, refAudio)) }
}

describe('speak overrides never persist', () => {
  beforeEach(async () => {
    await useDb().delete(voicePresets).where(like(voicePresets.name, 'test-%'))
  })

  it('leaves the row byte-identical after a four-seed audition', async () => {
    const created = await createPreset({
      name: 'test-audition',
      instruction: 'A neutral, low-key man.',
      cfgScale: 4,
      seed: 11,
      temperature: 0.9,
      topP: 1,
      topK: 50
    })
    const before = await getPreset(created.id)

    // Exactly what the studio now does: four renders, four different seeds, no PATCH.
    const seeds = [11, 4821, 99, 573204]
    for (const seed of seeds) {
      const { request, invalid } = await speakPreflight(created.id, { seed })
      expect(invalid).toBeNull()
      expect(request.seed).toBe(seed)
    }

    const after = await getPreset(created.id)
    expect(after).toEqual(before)
    // Named explicitly, because this is the field the old PATCH-and-restore shape left
    // stranded when a tab closed mid-audition — and the live agent reads this same row
    // on every turn.
    expect(after?.seed).toBe(11)

    await deletePreset(created.id)
  })

  it('leaves the row unchanged when the overrides carry unsaved slider edits too', async () => {
    const created = await createPreset({
      name: 'test-preview',
      instruction: 'A calm narrator.',
      cfgScale: 4,
      seed: 7,
      temperature: 0.9,
      topP: 1,
      topK: 50
    })
    const before = await getPreset(created.id)

    const { request } = await speakPreflight(created.id, {
      seed: 31337,
      instruction: 'A bright, energetic young man.',
      cfgScale: 7,
      temperature: 1.35,
      topP: 0.55,
      topK: 5
    })
    // The rig really does get the previewed values...
    expect(request.instruction).toBe('A bright, energetic young man.')
    expect(request.cfgScale).toBe(7)
    expect(request.topK).toBe(5)

    // ...and the row really does not.
    const after = await getPreset(created.id)
    expect(after).toEqual(before)
    expect(after?.instruction).toBe('A calm narrator.')
    expect(after?.cfgScale).toBe(4)
    expect(after?.seed).toBe(7)
    expect(after?.topK).toBe(50)

    await deletePreset(created.id)
  })

  it('leaves the row unchanged when the pre-flight REJECTS the combination', async () => {
    const created = await createPreset({ name: 'test-rejected', instruction: 'A calm narrator.', cfgScale: 4, seed: 5 })
    const before = await getPreset(created.id)

    const { invalid } = await speakPreflight(created.id, { cfgScale: 6, instruction: null })
    expect(invalid).toMatch(/requires an instruction/)

    expect(await getPreset(created.id)).toEqual(before)
    await deletePreset(created.id)
  })

  it('cannot raise the calibrated ceiling of a stored preset', async () => {
    const created = await createPreset({ name: 'test-ceiling', instruction: 'A calm narrator.', cfgScale: 4 })
    // `createPreset` does not carry maxSegmentChars on insert (it is not in its values
    // object) — calibration writes it through updatePreset, which is what presets.post.ts
    // does. Set it the same way so this fixture is really at a calibrated 90, not 200.
    await updatePreset(created.id, { maxSegmentChars: 90 })
    const stored = await resolvePreset(created.id)
    const merged = applyOverrides(stored, { maxSegmentChars: 5000 } as Parameters<typeof applyOverrides>[1])
    expect(merged.maxSegmentChars).toBe(90)
    expect((await getPreset(created.id))?.maxSegmentChars).toBe(90)
    await deletePreset(created.id)
  })
})
