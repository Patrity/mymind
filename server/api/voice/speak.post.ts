// server/api/voice/speak.post.ts
// Studio synthesis. Separate from the agent socket so an audition never rides the
// conversation's channel, and queued at STUDIO priority so it yields to a live turn.
import { speakSegments, collectPcm, pcmToWav, applyOverrides, presetToRequest } from '../../lib/voice/speak'
import { resolvePreset, loadReferenceBytes } from '../../services/voice-presets'
import { BreezeError, validateBreezeRequest } from '../../lib/voice/breeze'
import { planSegments, type SpeakMode } from '../../lib/voice/plan-segments'
import { VOICE_TUNING } from '../../lib/voice/tuning'
import type { SpeakOverrides } from '../../../shared/types/voice-presets'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    text?: string
    presetId?: string
    format?: 'pcm' | 'wav'
    /** Ad-hoc parameters for THIS request only — see applyOverrides. Never persisted. */
    overrides?: SpeakOverrides
    /** 'quality' (default) sends the text in one call where it fits; 'realtime' reproduces
     *  the live agent's segmentation. See plan-segments.ts for the measurements. */
    mode?: SpeakMode
  }>(event)
  const text = body.text?.trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'text is required' })
  const mode: SpeakMode = body.mode === 'realtime' ? 'realtime' : 'quality'

  const stored = await resolvePreset(body.presetId)
  // In memory, for this request alone. The studio auditions four seeds and previews
  // unsaved sliders through this path; none of it touches the row, so a tab closed
  // mid-audition cannot leave the preset — or the live agent, which resolves the same row
  // per turn — stuck on an audition value.
  const preset = applyOverrides(stored, body.overrides)
  const refAudio = await loadReferenceBytes(preset)

  // The rig's own pre-flight, run HERE so an illegal COMBINATION answers 400 with a
  // sentence instead of the opaque 500 Breeze returns for cfg > 1 without an instruction.
  // Overrides make that combination reachable without a row ever violating the matching
  // DB CHECK, so this is the only place it can be caught. Reused, not restated: the rule
  // lives in validateBreezeRequest and breezeSpeak runs the same function.
  const invalid = validateBreezeRequest(presetToRequest(text, preset, refAudio))
  if (invalid) throw createError({ statusCode: 400, statusMessage: invalid })

  // How the text reaches the rig. Before this, the studio sent EVERY render as a single call
  // whatever its length, which is right up to the ceiling and silently wrong past it: at
  // 1000+ characters the model stops tracking the text and rambles to the rig's 120s output
  // cap, returning a complete body full of words nobody wrote. The planner keeps the
  // one-call behaviour wherever it is safe — segmenting costs 10.3% more audio and audible
  // seams to buy 22ms, measured — and splits at the ceiling only when it has to.
  const plan = planSegments(text, preset, mode, VOICE_TUNING.tts.sentenceMaxChars)
  if (!plan.segments.length) throw createError({ statusCode: 400, statusMessage: 'text is required' })
  setHeader(event, 'x-segments', String(plan.segments.length))
  setHeader(event, 'x-segment-reason', plan.reason)
  setHeader(event, 'x-segment-ceiling', String(plan.ceiling))

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
      const { pcm, sampleRate } = await collectPcm(
        speakSegments(plan.segments, preset, 'studio', ac.signal, refAudio))
      setHeader(event, 'Content-Type', 'audio/wav')
      setHeader(event, 'Content-Disposition', `attachment; filename="${preset.name}.wav"`)
      return pcmToWav(pcm, sampleRate)
    }

    const chunks = speakSegments(plan.segments, preset, 'studio', ac.signal, refAudio)
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
          // Mapped, not raw. An error raised here is outside the handler's try/catch, so
          // without this it reached Nitro as an unknown throw and was logged "[unhandled]"
          // and answered as a bare 500 "Server Error" — with the message reduced to
          // undici's "terminated". That is precisely the prompt-ceiling overrun this cycle
          // exists to make legible, arriving as the least legible thing in the app.
          // toHttpError gives it the right status and keeps the sentence.
          controller.error(toHttpError(err))
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
