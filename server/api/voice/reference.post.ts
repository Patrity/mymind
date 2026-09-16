// server/api/voice/reference.post.ts
// A reference clip enters here by upload OR by mic recording — both arrive as a wav
// blob. Whisper (already in the registry for STT) fills ref_text, because Breeze needs
// the transcript to match the audio exactly and typing it by hand is error-prone.
import { storage } from '../../utils/storage'
import { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { sttFromModel } from '../../lib/voice/providers'
import { withFailover } from '../../lib/ai/registry/resolve'
import { wavDurationMs, REFERENCE_HARD_LIMIT_MS, REFERENCE_WARN_LIMIT_MS } from '../../lib/voice/wav'

export default defineEventHandler(async (event) => {
  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'audio')
  if (!file?.data?.length) throw createError({ statusCode: 400, statusMessage: 'audio file is required' })

  let durationMs: number
  try {
    durationMs = wavDurationMs(file.data)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Reference must be a WAV file' })
  }

  // The reference shares the prompt budget with the text, so an over-long clip does not
  // degrade quality — it makes long sentences fail outright, invisibly (200 + no body).
  if (durationMs > REFERENCE_HARD_LIMIT_MS) {
    throw createError({
      statusCode: 400,
      statusMessage: `Reference is ${(durationMs / 1000).toFixed(1)}s — the limit is ${REFERENCE_HARD_LIMIT_MS / 1000}s. Trim it to about 10 seconds of clean speech.`
    })
  }

  const { key } = await storage().put(Readable.from(Buffer.from(file.data)), { contentType: 'audio/wav' })
  const refText = await withFailover('stt', m =>
    sttFromModel(m).transcribe(new Uint8Array(file.data), { language: 'en' })
  ).catch(() => '')

  return {
    storageKey: key,
    refText,
    durationMs,
    warning: durationMs > REFERENCE_WARN_LIMIT_MS
      ? `${(durationMs / 1000).toFixed(1)}s is longer than the recommended 20s — shorter clips leave more prompt budget for the text.`
      : null
  }
})
