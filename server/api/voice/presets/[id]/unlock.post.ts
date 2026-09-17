// server/api/voice/presets/[id]/unlock.post.ts
// Return a locked voice to being a description again, so it can be re-cast.
//
// Only ever clears a reference this app RENDERED (`refSource: 'locked'`). A clip the user
// uploaded or recorded is theirs — losing it to a misplaced click would mean re-recording,
// and there is no undo here.
import { getPreset, updatePreset } from '../../../../services/voice-presets'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const preset = await getPreset(id)
  if (!preset) throw createError({ statusCode: 404, statusMessage: 'preset not found' })

  if (preset.refSource !== 'locked') {
    throw createError({
      statusCode: 400,
      statusMessage: preset.refStorageKey
        ? 'This voice uses a clip you provided. Remove it from the Reference tab instead.'
        : 'This voice is not locked.'
    })
  }

  // The blob stays in storage: keys are content-addressed, so another preset locked to an
  // identical render shares it. Same reasoning as deletePreset.
  return updatePreset(id, {
    refStorageKey: null,
    refText: null,
    refDurationMs: null,
    refSource: null,
    // The ceiling was measured against the clip that is now gone, so the measurement no
    // longer describes this preset. Reset both halves together — a cap left behind with its
    // marker cleared would read as "never calibrated" while carrying a calibrated number.
    maxSegmentChars: 200,
    calibratedRefKey: null,
  })
})
