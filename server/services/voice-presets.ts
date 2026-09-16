import { asc, eq } from 'drizzle-orm'
import { useDb } from '../db'
import { voicePresets, type VoicePresetRow } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { storage } from '../utils/storage'
import { BreezeError } from '../lib/voice/breeze'
import { speakWithPreset, collectPcm } from '../lib/voice/speak'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

export const DEFAULT_MAX_SEGMENT_CHARS = 200
export const FALLBACK_MAX_SEGMENT_CHARS = 100

/**
 * The voice of last resort. NOT a database row — it exists so that a database problem
 * (missing seed, dropped connection, migration mid-flight) can never silence the agent
 * entirely, and more importantly can never take the TEXT answer down with the audio.
 * Every field mirrors the seeded `neutral-lowkey` preset, so falling back here sounds
 * like the default voice rather than like a different product.
 *
 * It carries no reference clip on purpose: a fallback that needed a blob read would
 * reintroduce exactly the I/O dependency it exists to survive.
 */
export const FALLBACK_PRESET: VoicePresetDTO = {
  id: 'fallback-neutral-lowkey',
  name: 'Neutral, low-key (fallback)',
  instruction: 'A neutral, low-key man. Understated and unobtrusive, no performance, just clear.',
  cfgScale: 4,
  seed: 11,
  temperature: 0.9,
  topP: 1,
  topK: 50,
  refStorageKey: null,
  refText: null,
  refDurationMs: null,
  maxSegmentChars: DEFAULT_MAX_SEGMENT_CHARS,
  calibratedRefKey: null,
  isDefault: true
}

export function toDTO(r: VoicePresetRow): VoicePresetDTO {
  return {
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    cfgScale: r.cfgScale,
    seed: r.seed,
    temperature: r.temperature,
    topP: r.topP,
    topK: r.topK,
    refStorageKey: r.refStorageKey,
    refText: r.refText,
    refDurationMs: r.refDurationMs,
    maxSegmentChars: r.maxSegmentChars,
    calibratedRefKey: r.calibratedRefKey,
    isDefault: r.isDefault
  }
}

export interface PresetInput {
  name: string
  instruction?: string | null
  cfgScale?: number
  seed?: number
  temperature?: number
  topP?: number
  topK?: number
  refStorageKey?: string | null
  refText?: string | null
  refDurationMs?: number | null
  /** Derived by calibration, not chosen by the user — settable so the calibration pass
   *  can write it back through the same update path. Strip it (and `calibratedRefKey`)
   *  off anything that came from a request body: see `withoutCalibrationFields`. */
  maxSegmentChars?: number
  /** Written by the calibration pass only. */
  calibratedRefKey?: string | null
  isDefault?: boolean
}

export async function listPresets(): Promise<VoicePresetDTO[]> {
  const rows = await useDb().select().from(voicePresets).orderBy(asc(voicePresets.name))
  return rows.map(toDTO)
}

export async function getPreset(id: string): Promise<VoicePresetDTO | null> {
  const [row] = await useDb().select().from(voicePresets).where(eq(voicePresets.id, id)).limit(1)
  return row ? toDTO(row) : null
}

export async function getDefaultPreset(): Promise<VoicePresetDTO> {
  const [row] = await useDb().select().from(voicePresets).where(eq(voicePresets.isDefault, true)).limit(1)
  if (!row) throw new Error('No default voice preset — the voice_presets seed is missing')
  return toDTO(row)
}

/** The agent's resolution point: an unknown, absent, or malformed id falls back to the
 *  default rather than failing the turn. The id comes from an untrusted browser cookie —
 *  a preset can be deleted while a cookie still names it, and the cookie value itself can
 *  be hand-edited, truncated, or left over from an older build. `getPreset` runs the id
 *  against a `uuid` column, so a non-UUID string throws at the DB rather than missing;
 *  that failure must degrade exactly like a miss, not fail the turn.
 *
 *  The DEFAULT lookup is guarded for the same reason, and this is the important half:
 *  `getDefaultPreset` throws on a missing seed row and on any transient DB error, and this
 *  function now runs on every turn. An unguarded throw here propagates out of the turn
 *  closure in ws.ts and the user loses the TEXT answer over a voice lookup. Degrade to the
 *  hardcoded fallback instead — losing the configured voice is acceptable, losing the
 *  reply is not. */
export async function resolvePreset(id: string | null | undefined): Promise<VoicePresetDTO> {
  if (id) {
    try {
      const hit = await getPreset(id)
      if (hit) return hit
    } catch {
      // Malformed id (e.g. not a valid UUID) — treat the same as "not found".
    }
  }
  try {
    return await getDefaultPreset()
  } catch (err) {
    console.error('[voice] default preset lookup failed, using the hardcoded fallback:', err)
    return FALLBACK_PRESET
  }
}

/** Injectable seam for `resolveTurnVoice` — the app passes nothing and gets the real ones. */
export interface TurnVoiceDeps {
  resolve?: (id: string | null) => Promise<VoicePresetDTO>
  loadRef?: (p: VoicePresetDTO) => Promise<Uint8Array | null>
}

/**
 * Everything a turn needs from voice state, resolved so that NO failure here can cost the
 * user their answer. This is the seam ws.ts calls, on both the typed and the spoken path.
 *
 *  - `speak: false` touches nothing at all. A silent turn has no business hitting the DB or
 *    the storage layer, and before this cycle it never did — the fallback preset is only
 *    read for its `maxSegmentChars` (it caps the chunker) and nothing is ever synthesized.
 *  - A reference blob that is missing or unreadable degrades to no reference, so a clone
 *    preset speaks as a design preset. It sounds wrong; that is strictly better than the
 *    user getting nothing.
 *  - `resolvePreset` is already total (see above), so the preset itself cannot throw.
 */
export async function resolveTurnVoice(
  presetId: string | null,
  speak: boolean,
  deps: TurnVoiceDeps = {}
): Promise<{ preset: VoicePresetDTO; refAudio: Uint8Array | null }> {
  if (!speak) return { preset: FALLBACK_PRESET, refAudio: null }
  const preset = await (deps.resolve ?? resolvePreset)(presetId)
  const refAudio = await (deps.loadRef ?? loadReferenceBytes)(preset).catch((err: unknown) => {
    console.error('[voice] reference clip unreadable, speaking without it:', err)
    return null
  })
  return { preset, refAudio }
}

/** Clears any other default first — the partial unique index rejects a second one. */
async function clearOtherDefaults(exceptId?: string): Promise<void> {
  const db = useDb()
  const rows = await db.select().from(voicePresets).where(eq(voicePresets.isDefault, true))
  for (const r of rows) {
    if (r.id !== exceptId) await db.update(voicePresets).set({ isDefault: false }).where(eq(voicePresets.id, r.id))
  }
}

export async function createPreset(input: PresetInput): Promise<VoicePresetDTO> {
  if (input.isDefault) await clearOtherDefaults()
  const [row] = await useDb().insert(voicePresets).values({
    name: input.name,
    instruction: input.instruction ?? null,
    cfgScale: input.cfgScale ?? 4,
    seed: input.seed ?? 42,
    temperature: input.temperature ?? 0.9,
    topP: input.topP ?? 1,
    topK: input.topK ?? 50,
    refStorageKey: input.refStorageKey ?? null,
    refText: input.refText ?? null,
    refDurationMs: input.refDurationMs ?? null,
    isDefault: input.isDefault ?? false
  }).returning()
  if (!row) throw new Error('voice preset insert returned no row')
  publishChange({ resource: 'voicePreset', action: 'created', id: row.id })
  return toDTO(row)
}

export async function updatePreset(id: string, input: Partial<PresetInput>): Promise<VoicePresetDTO> {
  if (input.isDefault) await clearOtherDefaults(id)
  const [row] = await useDb().update(voicePresets)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(voicePresets.id, id)).returning()
  if (!row) throw new Error(`voice preset ${id} not found`)
  publishChange({ resource: 'voicePreset', action: 'updated', id })
  return toDTO(row)
}

export async function deletePreset(id: string): Promise<void> {
  const existing = await getPreset(id)
  if (!existing) return
  if (existing.isDefault) throw new Error('Cannot delete the default voice preset — make another preset the default first')
  await useDb().delete(voicePresets).where(eq(voicePresets.id, id))
  // The blob is left in storage: keys are content-addressed and may be shared with
  // another preset built from the same clip.
  publishChange({ resource: 'voicePreset', action: 'deleted', id })
}

/** Probe function shape: synthesizes `text` with the preset and resolves on success. */
export type CalibrationProbe = (text: string) => Promise<void>

/**
 * Establish the longest text this preset can synthesize without the prompt-ceiling
 * truncation. A reference consumes the same prompt budget as the text, so a clone-backed
 * preset cannot be assumed safe at the agent's default 200-char segment cap — and an
 * overrun is invisible (200 OK, empty body), so it must be measured rather than estimated.
 *
 * Reference-free presets run ~40-token prompts and cannot approach the ceiling; they skip
 * the probe entirely rather than burning a rig slot to confirm the obvious.
 */
export async function calibrateMaxSegmentChars(
  preset: VoicePresetDTO,
  probe: CalibrationProbe
): Promise<number> {
  if (!preset.refStorageKey) return DEFAULT_MAX_SEGMENT_CHARS
  const sample = (n: number) => 'The quick brown fox jumps over the lazy dog. '.repeat(20).slice(0, n)
  try {
    await probe(sample(DEFAULT_MAX_SEGMENT_CHARS))
    return DEFAULT_MAX_SEGMENT_CHARS
  } catch (err) {
    // Only a truncation tells us anything about the prompt budget. A busy rig or a
    // network blip is not evidence, and narrowing the cap on it would silently degrade
    // a perfectly good preset.
    if (!(err instanceof BreezeError) || err.code !== 'truncated') throw err
  }
  try {
    await probe(sample(FALLBACK_MAX_SEGMENT_CHARS))
  } catch (err) {
    if (!(err instanceof BreezeError) || err.code !== 'truncated') throw err
  }
  return FALLBACK_MAX_SEGMENT_CHARS
}

/** The app-wired probe: a real synthesis through the queue at studio priority. */
export function makeLiveProbe(preset: VoicePresetDTO, refAudio: Uint8Array | null): CalibrationProbe {
  return async (text: string) => {
    await collectPcm(speakWithPreset(text, preset, 'studio', undefined, refAudio))
  }
}

/**
 * Strip the fields calibration OWNS off anything that arrived in a request body.
 *
 * `max_segment_chars` and `calibrated_ref_key` are measurements, not preferences. Without
 * this a client could PATCH `{calibratedRefKey: <its own key>}` and the save path would
 * believe the preset had been probed — which is precisely the state this whole mechanism
 * exists to make impossible.
 */
export function withoutCalibrationFields<T extends Partial<PresetInput>>(
  input: T
): Omit<T, 'maxSegmentChars' | 'calibratedRefKey'> {
  const { maxSegmentChars: _cap, calibratedRefKey: _key, ...rest } = input ?? {}
  return rest
}

/** Injectable seams for `ensureCalibrated` — the app passes nothing and gets the real ones. */
export interface CalibrationDeps {
  /** Builds the probe for a preset, loading its reference clip. */
  makeProbe?: (preset: VoicePresetDTO) => Promise<CalibrationProbe>
  /** Persists the calibration result. */
  save?: (id: string, input: Partial<PresetInput>) => Promise<VoicePresetDTO>
}

const liveProbeFactory = async (preset: VoicePresetDTO): Promise<CalibrationProbe> =>
  makeLiveProbe(preset, await loadReferenceBytes(preset))

/**
 * Bring a just-saved preset's cap into agreement with its reference clip, and say so when
 * it could not be done.
 *
 * This replaces the old "recalibrate when the key CHANGED" test, which had a hole with
 * teeth: the row was written first, so a probe that threw (rig down, 409 — prod's exact
 * state until the DEPLOYMENT §4b registry repoint) 500ed the request with the new
 * reference already persisted. On the retry the keys matched, calibration was skipped, and
 * the preset kept an unmeasured 200 cap forever — a clone-backed voice on the live agent
 * whose invisible-truncation ceiling was never measured. The gate is therefore "is this
 * cap a MEASUREMENT of the clip the row currently carries", which a failed probe never
 * satisfies, so the next save tries again.
 *
 * Three outcomes, and nothing here can fail the save:
 *  - no reference: nothing to measure. Any cap/marker left behind by a clone→design
 *    demotion is reset, so a demoted preset does not keep a 100 cap it no longer earns.
 *  - already measured against THIS clip: no rig slot spent.
 *  - otherwise: probe. On success the cap and the key it was measured against are stored
 *    together. On failure the cap drops to the conservative floor and the marker stays
 *    NULL — the preset works, cannot overrun invisibly, and is still due a measurement.
 */
export async function ensureCalibrated(
  preset: VoicePresetDTO,
  deps: CalibrationDeps = {}
): Promise<{ preset: VoicePresetDTO; calibrationWarning: string | null }> {
  const save = deps.save ?? updatePreset

  if (!preset.refStorageKey) {
    const stale = preset.calibratedRefKey !== null || preset.maxSegmentChars !== DEFAULT_MAX_SEGMENT_CHARS
    if (!stale) return { preset, calibrationWarning: null }
    // A reference was REMOVED. The cap it justified goes with it.
    const reset = await save(preset.id, {
      maxSegmentChars: DEFAULT_MAX_SEGMENT_CHARS,
      calibratedRefKey: null
    })
    return { preset: reset, calibrationWarning: null }
  }

  if (preset.calibratedRefKey === preset.refStorageKey) return { preset, calibrationWarning: null }

  try {
    const probe = await (deps.makeProbe ?? liveProbeFactory)(preset)
    const max = await calibrateMaxSegmentChars(preset, probe)
    const measured = await save(preset.id, {
      maxSegmentChars: max,
      calibratedRefKey: preset.refStorageKey
    })
    return { preset: measured, calibrationWarning: null }
  } catch (err) {
    console.error('[voice] calibration failed; preset saved uncalibrated:', err)
    const uncalibrated = preset.maxSegmentChars === FALLBACK_MAX_SEGMENT_CHARS && preset.calibratedRefKey === null
      ? preset
      : await save(preset.id, { maxSegmentChars: FALLBACK_MAX_SEGMENT_CHARS, calibratedRefKey: null })
    return {
      preset: uncalibrated,
      calibrationWarning:
        'Saved, but this voice could not be calibrated — the rig did not answer the probe '
        + `(${err instanceof Error ? err.message : String(err)}). Until it does, the voice is `
        + `capped at the conservative ${FALLBACK_MAX_SEGMENT_CHARS} characters per segment. `
        + 'Save it again once the rig is back and it will be measured properly.'
    }
  }
}

/** Load a preset's reference clip bytes from storage, or null for a design preset. */
export async function loadReferenceBytes(preset: VoicePresetDTO): Promise<Uint8Array | null> {
  if (!preset.refStorageKey) return null
  const { stream } = await storage().get(preset.refStorageKey)
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c))
  return new Uint8Array(Buffer.concat(parts))
}
