// server/api/voice/speak.post.ts
// Studio synthesis. Separate from the agent socket so an audition never rides the
// conversation's channel, and queued at STUDIO priority so it yields to a live turn.
import { speakWithPreset, collectPcm, pcmToWav } from '../../lib/voice/speak'
import { resolvePreset, loadReferenceBytes } from '../../services/voice-presets'
import { BreezeError } from '../../lib/voice/breeze'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: string; presetId?: string; format?: 'pcm' | 'wav' }>(event)
  const text = body.text?.trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'text is required' })

  const preset = await resolvePreset(body.presetId)
  const refAudio = await loadReferenceBytes(preset)

  // h3's bridge from a returned Web ReadableStream to the Node response (sendStream's
  // pipeTo branch) does NOT observe a client disconnect: writing to a torn-down socket
  // fails silently rather than rejecting, so the stream's own cancel() is never invoked
  // by the framework (verified empirically against this repo's h3 version — a real
  // client abort left `cancel()` uncalled and `pull()` still looping). The response's
  // 'close' event is the signal that reliably fires on disconnect, so it drives the
  // AbortSignal that unwinds speak()'s `finally` and frees the queue slot.
  const ac = new AbortController()

  try {
    if (body.format === 'wav') {
      // A single for-await loop inside collectPcm — aborting the in-flight await is
      // enough to unwind the generator's `finally`; there is no separate iterator here
      // to explicitly return().
      event.node.res.on('close', () => ac.abort())
      const { pcm, sampleRate } = await collectPcm(speakWithPreset(text, preset, 'studio', ac.signal, refAudio))
      setHeader(event, 'Content-Type', 'audio/wav')
      setHeader(event, 'Content-Disposition', `attachment; filename="${preset.name}.wav"`)
      return pcmToWav(pcm, sampleRate)
    }

    const chunks = speakWithPreset(text, preset, 'studio', ac.signal, refAudio)
    const iterator = chunks[Symbol.asyncIterator]()
    // Registered only once the iterator exists, and calls BOTH abort() and return():
    // abort() alone only unwinds a generator that is mid-await, but between our manual
    // iterator.next() calls the generator is parked at a `yield` with nothing pending to
    // abort. h3 can also return without ever calling pull()/cancel() on the stream we
    // hand back (e.g. `!event.node.res.socket` in h3@1.15.11's sendStream), so cancel()
    // is not guaranteed to run either. Calling iterator.return() directly makes release
    // independent of another pull() ever happening — the one failure mode here whose
    // blast radius is every TTS request in the app, not just this one.
    event.node.res.on('close', () => {
      ac.abort()
      void iterator.return?.()
    })
    // Pull the begin chunk first so the sample rate can go out as a header before the body.
    const first = await iterator.next()
    const sampleRate = !first.done && first.value.kind === 'begin' ? first.value.sampleRate : 24000

    setHeader(event, 'Content-Type', 'application/octet-stream')
    setHeader(event, 'x-sample-rate', String(sampleRate))
    setHeader(event, 'Cache-Control', 'no-store')

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) { controller.close(); return }
          if (value.kind === 'pcm') controller.enqueue(value.bytes)
        } catch (err) {
          controller.error(err)
        }
      },
      // Spec-correct and harmless to keep, but redundant with the res.on('close', ...)
      // handler above — that is the mechanism this route actually depends on.
      cancel() { void iterator.return?.() }
    })
  } catch (err) {
    throw toHttpError(err)
  }
})

function toHttpError(err: unknown) {
  if (err instanceof BreezeError) {
    const status = err.code === 'busy' ? 503 : err.code === 'preflight' ? 400 : 502
    return createError({ statusCode: status, statusMessage: err.message })
  }
  return createError({ statusCode: 500, statusMessage: (err as Error).message })
}
