// app/composables/useRigRender.ts
import { ref, computed } from 'vue'
import { diagnoseTruncation, errorFromResponseBody, type SpeakRequestBody } from '~/lib/voice/studio'
import { readWavInfo } from '~/lib/voice/wav-encode'

export function useRigRender() {
  // ── Rendering against the rig ─────────────────────────────────────────────────
  //
  // The rig serves ONE request at a time and studio work is queued BEHIND the live agent,
  // so a render can legitimately sit waiting. The elapsed clock exists so that wait reads
  // as a queue rather than as a hang.
  const elapsedMs = ref(0)
  let clock: ReturnType<typeof setInterval> | null = null

  function startClock() {
    elapsedMs.value = 0
    clock = setInterval(() => {
      elapsedMs.value += 250
    }, 250)
  }

  function stopClock() {
    if (clock) clearInterval(clock)
    clock = null
  }

  const queued = computed(() => elapsedMs.value > 4000)

  /** One complete WAV from /api/voice/speak, plus whatever its size says about it.
   *  Takes the whole request body, `overrides` included — this is the ONLY network call the
   *  audition makes, which is what makes "an audition never writes" a property of the code
   *  rather than a promise. */
  async function renderWav(body: SpeakRequestBody, signal?: AbortSignal): Promise<{ blob: Blob, note: string | null }> {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `format` belongs in the BODY — it is not a query parameter on this route.
      body: JSON.stringify(body),
      // Switching preset aborts the render outright: the rig has ONE inference slot, and an
      // abandoned audition holding it is the newly selected preset waiting on nothing.
      signal
    })
    // Parsed, not raw: `fetch` returns the whole h3 JSON error envelope, and the
    // pre-flight's 400 sentence is one field inside it.
    if (!res.ok) throw new Error(errorFromResponseBody(await res.text().catch(() => ''), res.statusText))
    const blob = await res.blob()
    const info = readWavInfo(new Uint8Array(await blob.arrayBuffer()))
    return {
      blob,
      note: diagnoseTruncation({
        chars: body.text.length,
        audioBytes: info?.dataBytes ?? 0,
        sampleRate: info?.sampleRate ?? 24000
      })
    }
  }

  return { elapsedMs, queued, startClock, stopClock, renderWav }
}
