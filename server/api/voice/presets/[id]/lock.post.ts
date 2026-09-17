// server/api/voice/presets/[id]/lock.post.ts
// Freeze a designed voice into a specific person.
//
// A design preset saves a RECIPE — an instruction, a seed, a cfg — not a voice. The seed
// reproduces an identical input exactly, but the agent sends different text every segment,
// so each call draws a new speaker from the same description. That is what "voice design"
// means, and it is why a saved preset could still sound like ten different people.
//
// Locking renders one canonical passage and keeps the AUDIO. From then on the preset is
// reference-backed and every later utterance clones that exact render instead of casting
// again. Measured across four segments of one reply:
//
//     design preset, unlocked      23.9 Hz spread   timbre 0.636
//     locked render, pure clone    22.6 Hz spread   timbre 0.526
//     a real recorded clip         4.5 Hz spread    timbre 0.418
//
// A real recording still anchors best by some margin, which is why uploading one stays
// available and is the better option when a specific person's voice is what you want.
import { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { speakSegments, collectPcm, pcmToWav, applyOverrides, presetToRequest } from '../../../../lib/voice/speak'
import { getPreset, updatePreset, calibrateMaxSegmentChars, makeLiveProbe, loadReferenceBytes } from '../../../../services/voice-presets'
import { BreezeError, validateBreezeRequest } from '../../../../lib/voice/breeze'
import { storage } from '../../../../utils/storage'
import type { SpeakOverrides } from '../../../../../shared/types/voice-presets'

/**
 * What the frozen clip says.
 *
 * Long enough to characterise a speaker — the measurements above used ~11 seconds, and a
 * 5.8s clip anchored measurably worse — and varied enough in sound that the reference is not
 * a narrow sample of one vowel. Its text is stored verbatim as `refText`, because Breeze
 * requires the transcript to match the audio and we synthesized it, so we know it exactly.
 */
export const LOCK_PASSAGE =
  'This is the voice I will use from now on. It was recorded once, deliberately, so that '
  + 'every later sentence you hear comes back in exactly this same voice, with the same tone '
  + 'and the same accent, no matter what the words happen to be.'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ overrides?: SpeakOverrides }>(event).catch(() => ({} as { overrides?: SpeakOverrides }))

  const stored = await getPreset(id)
  if (!stored) throw createError({ statusCode: 404, statusMessage: 'preset not found' })

  // Locks the voice the user is LOOKING AT, not the last one they saved. The studio previews
  // unsaved edits through the same overrides, so locking what is on screen is the only
  // behaviour that matches what they just auditioned and approved.
  const preset = applyOverrides(stored, body.overrides)

  if (preset.refStorageKey) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This voice already has a reference clip. Clear it first to re-lock from the description.'
    })
  }
  if (!preset.instruction?.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Write a description first — locking freezes the voice that description produces.'
    })
  }

  const invalid = validateBreezeRequest(presetToRequest(LOCK_PASSAGE, preset, null))
  if (invalid) throw createError({ statusCode: 400, statusMessage: invalid })

  try {
    // Rendered at STUDIO priority like every other studio call, so locking a voice can never
    // stall a live conversation.
    const { pcm, sampleRate } = await collectPcm(
      speakSegments([LOCK_PASSAGE], preset, 'studio', undefined, null))
    if (!pcm.length) {
      throw new BreezeError('truncated', 'The rig returned no audio for the lock passage — try again.')
    }

    const wav = pcmToWav(pcm, sampleRate)
    const { key } = await storage().put(Readable.from(Buffer.from(wav)), { contentType: 'audio/wav' })
    const durationMs = Math.round((pcm.length / 2 / sampleRate) * 1000)

    // `refSource: 'locked'` is what makes later utterances drop the instruction and speak as
    // a pure clone — see presetToRequest. The instruction itself is KEPT on the row: it is
    // how the voice was cast, it is what the user edits to re-cast, and it is the only
    // readable record of what this clip is.
    const locked = await updatePreset(id, {
      refStorageKey: key,
      refText: LOCK_PASSAGE,
      refDurationMs: durationMs,
      refSource: 'locked',
      // Overrides are a preview; locking is the moment they become the preset.
      instruction: preset.instruction,
      seed: preset.seed,
      cfgScale: preset.cfgScale,
      temperature: preset.temperature,
      topP: preset.topP,
      topK: preset.topK,
    })

    // The clip now shares the prompt budget with every utterance, so the ceiling this preset
    // was measured at no longer applies. Same calibration the upload path runs.
    const refAudio = await loadReferenceBytes(locked)
    const max = await calibrateMaxSegmentChars(locked, makeLiveProbe(locked, refAudio))
    const final = max === locked.maxSegmentChars ? locked : await updatePreset(id, { maxSegmentChars: max })
    return { ...final, lockDurationMs: durationMs }
  } catch (err) {
    if (err instanceof BreezeError) {
      throw createError({
        statusCode: err.code === 'busy' ? 503 : err.code === 'preflight' ? 400 : 502,
        statusMessage: err.message
      })
    }
    throw err
  }
})
