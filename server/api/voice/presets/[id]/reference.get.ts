// server/api/voice/presets/[id]/reference.get.ts
// Serve a preset's reference clip so the studio can play it back.
//
// Until this existed there was no way to HEAR an attached clip — the pane said "11.9s clip
// attached" and that was all. That gap matters most for a locked voice, where the clip is
// the only record of the person the preset now speaks as.
//
// Addressed by PRESET, not by storage key. The key is a content hash, so a key-addressed
// route would serve any blob in the bucket to anyone who could name one; going through the
// row means the only clips reachable are the ones a preset actually references.
import { getPreset } from '../../../../services/voice-presets'
import { storage } from '../../../../utils/storage'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const preset = await getPreset(id)
  if (!preset) throw createError({ statusCode: 404, statusMessage: 'preset not found' })
  if (!preset.refStorageKey) {
    throw createError({ statusCode: 404, statusMessage: 'This voice has no reference clip.' })
  }

  const { stream } = await storage().get(preset.refStorageKey).catch(() => {
    // The row points at a blob that is gone. Say which of the two failed, because "404" on a
    // preset that visibly claims a clip reads as a bug in the page.
    throw createError({ statusCode: 404, statusMessage: 'The reference clip is missing from storage.' })
  })

  setResponseHeaders(event, {
    'content-type': 'audio/wav',
    // Content-addressed: a given key is always the same bytes, so this can be cached hard.
    // Private because a voice clip is the user's own recording.
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff'
  })
  return sendStream(event, stream)
})
