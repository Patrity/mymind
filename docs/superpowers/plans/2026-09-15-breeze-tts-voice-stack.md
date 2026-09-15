# Breeze TTS 2 Voice Stack + /voice Studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead Kokoro/Chatterbox/Orpheus TTS chain with Breeze TTS 2 as the single engine, streaming PCM end-to-end, and add a `/voice` studio for authoring voice presets (design, clone, direction) and reading MyMind content aloud.

**Architecture:** One `breeze.ts` client owns the multipart wire format and every constraint that cannot be recovered from a response. One in-process priority queue serialises access (Breeze serves one request at a time). Voices stop being a provider-supplied enum and become `voice_presets` rows we author. The multi-provider TTS failover machinery is deleted rather than left inert, which is what allows per-segment buffering to be removed — and that removal is what turns 1.9× realtime throughput into a ~6 ms first sample.

**Tech Stack:** Nuxt 4 · Nitro (WebSocket + server routes) · Drizzle ORM / PostgreSQL 16 · Vue 3 + Nuxt UI v4 · Vitest · Web Audio API

**Spec:** [`docs/superpowers/specs/2026-09-15-breeze-tts-voice-stack-design.md`](../specs/2026-09-15-breeze-tts-voice-stack-design.md)

## Global Constraints

- **Package manager is `pnpm`.** Never npm or yarn.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm build`. Lint is red repo-wide and is **not** a gate.
- **DB-backed tests must be named `*.db.test.ts`** — they are excluded from `pnpm test` (CI has no Postgres) and run via `pnpm test:db`. A preset test that touches the database and is named `*.test.ts` will fail CI.
- **Breeze base URL** comes from the AI config registry (`assignments.tts`, first entry wins), never from an env var read at call time. Rig endpoint today: `http://192.168.2.25:8880`.
- **Breeze serves ONE request at a time.** Every call site goes through `breezeQueue`. Never call `breezeSpeak` directly outside `speak.ts`.
- **Audio format:** mono, signed 16-bit little-endian PCM, **no container header**. Sample rate is read from the `x-sample-rate` response header, never hardcoded.
- **`cfg_scale > 1.0` requires a non-empty `instruction`** — otherwise Breeze returns `500` with an opaque `Internal Server Error` body. Must be rejected pre-flight.
- **`ref_audio` requires a non-empty `ref_text`.** Same treatment.
- **A prompt-ceiling overrun arrives as `200 OK` with a truncated/empty body.** Never infer success from the status code; count bytes.
- **English only.** No `language` column, no Chinese event syntax, no instruction-language warning (spec: out of scope).
- **No TTS fallback.** Breeze is the only engine by design; do not add a second provider or a retry-on-another-model path.
- **Commit after every task.** Never add co-authors or model references beyond the trailer shown in each commit step.

## Shared Types (defined in Task 1, used everywhere)

These exact names and types are relied on by later tasks. Do not rename.

```ts
// shared/types/voice-presets.ts
export type VoiceMode = 'plain' | 'design' | 'clone' | 'direction'

export interface VoicePresetDTO {
  id: string
  name: string
  instruction: string | null
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refStorageKey: string | null
  refText: string | null
  refDurationMs: number | null
  maxSegmentChars: number
  isDefault: boolean
}
```

## File Structure

| File | Responsibility |
|---|---|
| `shared/types/voice-presets.ts` | `VoicePresetDTO`, `VoiceMode`, `presetMode()` — shared client/server |
| `server/lib/voice/breeze.ts` | The ONLY module that knows Breeze's wire format |
| `server/lib/voice/breeze-queue.ts` | Single-slot priority queue (agent > studio) |
| `server/lib/voice/speak.ts` | Composes queue + breeze + preset; `pcmToWav` |
| `server/db/schema/voice-presets.ts` | `voice_presets` table |
| `server/services/voice-presets.ts` | Preset CRUD + calibration |
| `server/api/voice/presets*.ts` | Preset REST endpoints |
| `server/api/voice/speak.post.ts` | Studio synthesis (streams PCM) |
| `server/api/voice/reference.post.ts` | Reference upload + whisper auto-transcribe |
| `app/pages/voice.vue` | The studio page (3 panes) |
| `app/components/voice/PresetRail.vue` | Preset list/create/duplicate/delete |
| `app/components/voice/DesignPane.vue` | Instruction, sliders, seed audition, reference |
| `app/components/voice/SpeakPane.vue` | Text, MyMind picker, event bar, player, download |
| `app/composables/useBreezeSpeech.ts` | Client PCM streaming + scheduling (studio) |

**Deleted:** `server/lib/voice/providers/tts-openai.ts`, `test/tts-openai.test.ts`, `server/api/voice/voices.get.ts`, and `pinChainToProvider` + chain logic in `server/lib/voice/tts-failover.ts`.

---

### Task 1: Shared preset types + mode derivation

**Files:**
- Create: `shared/types/voice-presets.ts`
- Test: `shared/types/voice-presets.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `VoiceMode`, `VoicePresetDTO` (both exactly as in Shared Types above), and
  `presetMode(p: Pick<VoicePresetDTO, 'instruction' | 'refStorageKey'>): VoiceMode`

- [ ] **Step 1: Write the failing test**

```ts
// shared/types/voice-presets.test.ts
import { describe, it, expect } from 'vitest'
import { presetMode } from './voice-presets'

describe('presetMode', () => {
  it('is plain with neither instruction nor reference', () => {
    expect(presetMode({ instruction: null, refStorageKey: null })).toBe('plain')
  })
  it('is design with an instruction and no reference', () => {
    expect(presetMode({ instruction: 'A calm man.', refStorageKey: null })).toBe('design')
  })
  it('is clone with a reference and no instruction', () => {
    expect(presetMode({ instruction: null, refStorageKey: 'abc' })).toBe('clone')
  })
  it('is direction with both', () => {
    expect(presetMode({ instruction: 'Warmly.', refStorageKey: 'abc' })).toBe('direction')
  })
  it('treats a whitespace-only instruction as absent', () => {
    expect(presetMode({ instruction: '   ', refStorageKey: null })).toBe('plain')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run shared/types/voice-presets.test.ts`
Expected: FAIL — "Failed to resolve import ./voice-presets"

- [ ] **Step 3: Write minimal implementation**

```ts
// shared/types/voice-presets.ts
// The four Breeze modes are a FUNCTION of which fields are populated — exactly how the
// rig picks its template. Never store a `mode` column: a stored mode can contradict the
// fields, a derived one cannot.
export type VoiceMode = 'plain' | 'design' | 'clone' | 'direction'

export interface VoicePresetDTO {
  id: string
  name: string
  instruction: string | null
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refStorageKey: string | null
  refText: string | null
  refDurationMs: number | null
  /** Longest text (in characters) this preset is known to synthesize without the
   *  prompt-ceiling truncation. Calibrated on save for reference-backed presets. */
  maxSegmentChars: number
  isDefault: boolean
}

export function presetMode(p: Pick<VoicePresetDTO, 'instruction' | 'refStorageKey'>): VoiceMode {
  const hasInstruction = !!p.instruction?.trim()
  const hasRef = !!p.refStorageKey
  if (hasInstruction && hasRef) return 'direction'
  if (hasRef) return 'clone'
  if (hasInstruction) return 'design'
  return 'plain'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run shared/types/voice-presets.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add shared/types/voice-presets.ts shared/types/voice-presets.test.ts
git commit -m "feat(voice): shared voice-preset types with derived mode

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 2: Breeze client — pre-flight validation

**Files:**
- Create: `server/lib/voice/breeze.ts`
- Test: `server/lib/voice/breeze.test.ts`

**Interfaces:**
- Consumes: `VoicePresetDTO` from Task 1
- Produces:
  - `class BreezeError extends Error { readonly code: BreezeErrorCode }`
  - `type BreezeErrorCode = 'preflight' | 'busy' | 'truncated' | 'http' | 'network'`
  - `validateBreezeRequest(req: BreezeRequest): string | null` — message on failure, `null` on pass
  - `interface BreezeRequest { text, instruction, cfgScale, seed, temperature, topP, topK, refAudio, refText }`

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/voice/breeze.test.ts
import { describe, it, expect } from 'vitest'
import { validateBreezeRequest, type BreezeRequest } from './breeze'

const base: BreezeRequest = {
  text: 'Hello.', instruction: null, cfgScale: 1.0, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
}

describe('validateBreezeRequest', () => {
  it('passes a plain request', () => {
    expect(validateBreezeRequest(base)).toBeNull()
  })

  // The rig answers this with 500 + an opaque "Internal Server Error" body — there is
  // nothing in the response to branch on, so it MUST be caught before dispatch.
  it('rejects cfg_scale > 1 without an instruction', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4 }))
      .toMatch(/cfg_scale/)
  })

  it('accepts cfg_scale > 1 when an instruction is present', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4, instruction: 'A calm man.' })).toBeNull()
  })

  it('treats a whitespace-only instruction as absent for the cfg_scale rule', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4, instruction: '  ' }))
      .toMatch(/cfg_scale/)
  })

  it('rejects ref_audio without ref_text', () => {
    expect(validateBreezeRequest({ ...base, refAudio: { bytes: new Uint8Array([1]), filename: 'r.wav' } }))
      .toMatch(/ref_text/)
  })

  it('rejects empty text', () => {
    expect(validateBreezeRequest({ ...base, text: '   ' })).toMatch(/text/)
  })

  it('rejects cfg_scale <= 0', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 0 })).toMatch(/cfg_scale/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/breeze.test.ts`
Expected: FAIL — "Failed to resolve import ./breeze"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/lib/voice/breeze.ts
// The ONLY module that knows Breeze's wire format.
//
// Three facts here were measured against the live rig (2026-09-15) and are not
// recoverable from a response, which is why they are enforced before dispatch:
//   1. cfg_scale > 1 with no instruction => 500 "Internal Server Error" (no negative
//      prompt exists on the non-instruction templates).
//   2. ref_audio without ref_text => 500, same opaque body.
//   3. A prompt-ceiling overrun => 200 OK with a body that dies at zero bytes. The
//      status code can never carry it, because headers are sent before generation.

export type BreezeErrorCode = 'preflight' | 'busy' | 'truncated' | 'http' | 'network'

export class BreezeError extends Error {
  constructor(public readonly code: BreezeErrorCode, message: string) {
    super(message)
    this.name = 'BreezeError'
  }
}

export interface BreezeRequest {
  text: string
  instruction: string | null
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refAudio: { bytes: Uint8Array; filename: string } | null
  refText: string | null
}

/** Returns a human-readable reason the request would fail at the rig, or null. */
export function validateBreezeRequest(req: BreezeRequest): string | null {
  if (!req.text?.trim()) return 'text is required'
  if (req.cfgScale <= 0) return 'cfg_scale must be greater than 0'
  if (req.cfgScale > 1 && !req.instruction?.trim()) {
    return 'cfg_scale above 1.0 requires an instruction (the clone/plain templates define no negative prompt)'
  }
  if (req.refAudio && !req.refText?.trim()) return 'ref_audio requires ref_text (the exact transcript)'
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/voice/breeze.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/breeze.ts server/lib/voice/breeze.test.ts
git commit -m "feat(voice): Breeze pre-flight validation

Both rules are 500s with opaque bodies at the rig, so they have to be
caught before dispatch rather than diagnosed from the response.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 3: Breeze client — multipart request + streaming PCM + truncation detection

**Files:**
- Modify: `server/lib/voice/breeze.ts`
- Modify: `server/lib/voice/breeze.test.ts`

**Interfaces:**
- Consumes: `BreezeRequest`, `BreezeError`, `validateBreezeRequest` from Task 2
- Produces:
  - `interface BreezeStream { sampleRate: number; chunks: AsyncIterable<Uint8Array> }`
  - `breezeSpeak(baseURL: string, req: BreezeRequest, signal?: AbortSignal): Promise<BreezeStream>`

- [ ] **Step 1: Write the failing test**

Append to `server/lib/voice/breeze.test.ts`:

```ts
import { vi, afterEach } from 'vitest'
import { breezeSpeak, BreezeError } from './breeze'

afterEach(() => vi.restoreAllMocks())

function pcmResponse(chunks: number[][], headers: Record<string, string> = { 'x-sample-rate': '24000' }) {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close() }
  })
  return new Response(body, { status: 200, headers })
}

async function drain(s: AsyncIterable<Uint8Array>) {
  const out: number[] = []
  for await (const c of s) out.push(...c)
  return out
}

describe('breezeSpeak', () => {
  const req = {
    text: 'Hello.', instruction: 'A calm man.', cfgScale: 4, seed: 11,
    temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
  }

  it('POSTs multipart to /v1/audio/speech with `text`, not `input`', async () => {
    const fetchMock = vi.fn(async () => pcmResponse([[1, 2, 3]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880', req)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://rig:8880/v1/audio/speech')
    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(form.get('text')).toBe('Hello.')
    expect(form.get('input')).toBeNull()
    expect(form.get('instruction')).toBe('A calm man.')
    expect(form.get('cfg_scale')).toBe('4')
    expect(form.get('seed')).toBe('11')
  })

  it('strips a trailing slash from the base URL', async () => {
    const fetchMock = vi.fn(async () => pcmResponse([[1]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880/', req)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://rig:8880/v1/audio/speech')
  })

  it('reads the sample rate from the response header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1]], { 'x-sample-rate': '16000' })))
    const s = await breezeSpeak('http://rig:8880', req)
    expect(s.sampleRate).toBe(16000)
  })

  it('falls back to 24000 when the header is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1]], {})))
    const s = await breezeSpeak('http://rig:8880', req)
    expect(s.sampleRate).toBe(24000)
  })

  it('streams chunks through without buffering them into one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1, 2], [3, 4]])))
    const s = await breezeSpeak('http://rig:8880', req)
    const seen: number[][] = []
    for await (const c of s.chunks) seen.push([...c])
    expect(seen).toEqual([[1, 2], [3, 4]])
  })

  it('omits ref fields entirely when there is no reference', async () => {
    const fetchMock = vi.fn(async () => pcmResponse([[1]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880', req)
    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(form.get('ref_audio')).toBeNull()
  })

  it('sends ref_audio + ref_text when a reference is present', async () => {
    const fetchMock = vi.fn(async () => pcmResponse([[1]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880', {
      ...req, cfgScale: 1, instruction: null,
      refAudio: { bytes: new Uint8Array([9, 9]), filename: 'ref.wav' }, refText: 'transcript'
    })
    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(form.get('ref_text')).toBe('transcript')
    expect(form.get('ref_audio')).toBeInstanceOf(Blob)
  })

  it('rejects a pre-flight failure without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(breezeSpeak('http://rig:8880', { ...req, instruction: null }))
      .rejects.toMatchObject({ code: 'preflight' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps 409 to a busy error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'An inference request is already running.' }), { status: 409 })))
    await expect(breezeSpeak('http://rig:8880', req)).rejects.toMatchObject({ code: 'busy' })
  })

  it('maps a non-409 error status to an http error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal Server Error', { status: 500 })))
    await expect(breezeSpeak('http://rig:8880', req)).rejects.toMatchObject({ code: 'http' })
  })

  // THE critical case: the rig sends 200 + headers BEFORE generation, so a prompt-ceiling
  // overrun arrives as a successful response with an empty body. Yielding nothing here
  // would be silent, undetectable dropped audio.
  it('throws `truncated` when a 200 response produces zero bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([])))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).rejects.toMatchObject({ code: 'truncated' })
  })

  it('does not throw truncated when at least one byte arrived', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[7]])))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).resolves.toEqual([7])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/breeze.test.ts`
Expected: FAIL — "breezeSpeak is not exported"

- [ ] **Step 3: Write minimal implementation**

Append to `server/lib/voice/breeze.ts`:

```ts
const DEFAULT_SAMPLE_RATE = 24000

export interface BreezeStream {
  /** From the `x-sample-rate` response header; never assume a constant. */
  sampleRate: number
  chunks: AsyncIterable<Uint8Array>
}

/**
 * Dial Breeze. Resolves once the response HEADERS are in (so the caller learns the
 * sample rate immediately); audio arrives by iterating `chunks`.
 *
 * NOT rate-limited on its own — Breeze serves one request at a time. Every caller
 * must hold a breezeQueue slot for the whole lifetime of `chunks`.
 */
export async function breezeSpeak(baseURL: string, req: BreezeRequest, signal?: AbortSignal): Promise<BreezeStream> {
  const invalid = validateBreezeRequest(req)
  if (invalid) throw new BreezeError('preflight', invalid)

  const form = new FormData()
  form.set('text', req.text)
  if (req.instruction?.trim()) form.set('instruction', req.instruction.trim())
  form.set('cfg_scale', String(req.cfgScale))
  form.set('seed', String(req.seed))
  form.set('temperature', String(req.temperature))
  form.set('top_p', String(req.topP))
  form.set('top_k', String(req.topK))
  if (req.refAudio) {
    form.set('ref_text', req.refText ?? '')
    form.set('ref_audio', new Blob([req.refAudio.bytes], { type: 'audio/wav' }), req.refAudio.filename)
  }

  const base = baseURL.replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/v1/audio/speech`, { method: 'POST', body: form, signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new BreezeError('network', `Breeze unreachable at ${base}: ${(err as Error).message}`)
  }

  if (res.status === 409) throw new BreezeError('busy', 'Breeze is already running an inference request')
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new BreezeError('http', `Breeze returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }

  const sampleRate = Number(res.headers.get('x-sample-rate')) || DEFAULT_SAMPLE_RATE
  const body = res.body

  async function* chunks(): AsyncIterable<Uint8Array> {
    let total = 0
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        total += value.length
        yield value
      }
    } finally {
      reader.releaseLock()
    }
    // 200 + zero bytes is the prompt-ceiling overrun. It cannot be detected any other
    // way: the status line was already sent before generation started.
    if (total === 0) {
      throw new BreezeError('truncated',
        'Breeze returned no audio — the prompt most likely exceeded a fast-mode bucket. Shorten the text or the reference clip.')
    }
  }

  return { sampleRate, chunks: chunks() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/voice/breeze.test.ts`
Expected: PASS — 19 tests total (7 from Task 2 + 12 here)

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/breeze.ts server/lib/voice/breeze.test.ts
git commit -m "feat(voice): Breeze multipart client with streaming PCM

Chunks pass straight through — no per-segment buffering, which is what
keeps time-to-first-audio at the measured ~6ms rather than half the
segment's duration.

A 200 with zero bytes is the prompt-ceiling overrun and throws; the
status code cannot carry it because headers precede generation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 4: Single-slot priority queue

**Files:**
- Create: `server/lib/voice/breeze-queue.ts`
- Test: `server/lib/voice/breeze-queue.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type QueuePriority = 'agent' | 'studio'`
  - `interface BreezeQueue { acquire(priority: QueuePriority, signal?: AbortSignal): Promise<() => void>; readonly depth: number }`
  - `createBreezeQueue(): BreezeQueue`
  - `const breezeQueue: BreezeQueue` — the process singleton

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/voice/breeze-queue.test.ts
import { describe, it, expect } from 'vitest'
import { createBreezeQueue } from './breeze-queue'

const tick = () => new Promise(r => setTimeout(r, 0))

describe('createBreezeQueue', () => {
  it('grants the first acquire immediately', async () => {
    const q = createBreezeQueue()
    const release = await q.acquire('studio')
    expect(typeof release).toBe('function')
    release()
  })

  it('serialises: a second acquire waits until the first releases', async () => {
    const q = createBreezeQueue()
    const order: string[] = []
    const r1 = await q.acquire('studio')
    order.push('first-held')
    let r2!: () => void
    const second = q.acquire('studio').then(r => { order.push('second-granted'); r2 = r })
    await tick()
    expect(order).toEqual(['first-held'])   // still blocked
    r1()
    await second
    expect(order).toEqual(['first-held', 'second-granted'])
    r2()
  })

  // The whole point of the priority: auditioning a voice in the studio must never
  // stall a live conversation behind it.
  it('grants agent before studio regardless of arrival order', async () => {
    const q = createBreezeQueue()
    const granted: string[] = []
    const r1 = await q.acquire('agent')            // holds the slot
    const s = q.acquire('studio').then(r => { granted.push('studio'); r() })
    await tick()
    const a = q.acquire('agent').then(r => { granted.push('agent'); r() })
    await tick()
    r1()
    await Promise.all([s, a])
    expect(granted).toEqual(['agent', 'studio'])
  })

  it('keeps FIFO order within the same priority', async () => {
    const q = createBreezeQueue()
    const granted: number[] = []
    const r1 = await q.acquire('studio')
    const waiters = [1, 2, 3].map(n => q.acquire('studio').then(r => { granted.push(n); r() }))
    await tick()
    r1()
    await Promise.all(waiters)
    expect(granted).toEqual([1, 2, 3])
  })

  it('reports depth of waiters', async () => {
    const q = createBreezeQueue()
    const r1 = await q.acquire('studio')
    expect(q.depth).toBe(0)
    const w = q.acquire('studio')
    await tick()
    expect(q.depth).toBe(1)
    r1()
    ;(await w)()
    expect(q.depth).toBe(0)
  })

  it('a waiter aborted before being granted rejects and does not consume the slot', async () => {
    const q = createBreezeQueue()
    const ac = new AbortController()
    const r1 = await q.acquire('studio')
    const rejected = q.acquire('studio', ac.signal)
    await tick()
    ac.abort()
    await expect(rejected).rejects.toThrow()
    const after = q.acquire('studio')
    r1()
    const r = await after            // must be grantable, i.e. the aborted waiter was removed
    expect(typeof r).toBe('function')
    r()
  })

  it('releasing twice does not hand the slot out twice', async () => {
    const q = createBreezeQueue()
    const r1 = await q.acquire('studio')
    const granted: number[] = []
    const w1 = q.acquire('studio').then(r => { granted.push(1); return r })
    const w2 = q.acquire('studio').then(r => { granted.push(2); return r })
    await tick()
    r1(); r1()                       // double release
    await tick()
    expect(granted).toEqual([1])     // w2 still waiting
    ;(await w1)()
    ;(await w2)()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/breeze-queue.test.ts`
Expected: FAIL — "Failed to resolve import ./breeze-queue"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/lib/voice/breeze-queue.ts
// Breeze serves ONE inference at a time and returns 409 to anything else. Since MyMind
// is a single Nitro process, one in-process queue is the entire concurrency story — a
// 409 escaping to a caller means something OUTSIDE MyMind took the slot (the interim
// Gradio studio on the rig), not that this queue failed.
//
// Two priorities, because a 30-second narration audition must never stall a live
// conversation behind it.

export type QueuePriority = 'agent' | 'studio'

interface Waiter {
  priority: QueuePriority
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  cleanup: () => void
}

export interface BreezeQueue {
  /** Resolves with a release function once the slot is yours. Call release EXACTLY once,
   *  in a finally, after the audio stream is fully drained or has errored. */
  acquire(priority: QueuePriority, signal?: AbortSignal): Promise<() => void>
  /** Number of waiters not yet granted the slot. */
  readonly depth: number
}

export function createBreezeQueue(): BreezeQueue {
  let held = false
  const waiters: Waiter[] = []

  function grantNext(): void {
    if (held) return
    // Agent first, then FIFO within priority. findIndex preserves insertion order
    // among equals, which is what keeps same-priority calls in arrival order.
    let idx = waiters.findIndex(w => w.priority === 'agent')
    if (idx === -1) idx = waiters.length ? 0 : -1
    if (idx === -1) return
    const [w] = waiters.splice(idx, 1)
    if (!w) return
    w.cleanup()
    held = true
    w.resolve(makeRelease())
  }

  function makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return        // double-release must not hand the slot out twice
      released = true
      held = false
      grantNext()
    }
  }

  return {
    acquire(priority, signal) {
      if (signal?.aborted) return Promise.reject(new Error('aborted before acquiring TTS slot'))
      return new Promise<() => void>((resolve, reject) => {
        if (!held && waiters.length === 0) {
          held = true
          resolve(makeRelease())
          return
        }
        const onAbort = () => {
          const i = waiters.indexOf(waiter)
          if (i !== -1) waiters.splice(i, 1)
          reject(new Error('aborted while waiting for TTS slot'))
        }
        const waiter: Waiter = {
          priority,
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener('abort', onAbort)
        }
        waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    get depth() { return waiters.length }
  }
}

export const breezeQueue: BreezeQueue = createBreezeQueue()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/voice/breeze-queue.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/breeze-queue.ts server/lib/voice/breeze-queue.test.ts
git commit -m "feat(voice): single-slot priority queue for Breeze

Agent utterances preempt studio auditions so a long narration render
cannot stall a live conversation. A 409 reaching a caller now means an
external client took the rig's slot, not a bug in here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 5: `speak.ts` — compose queue + breeze + preset, and WAV wrapping

**Files:**
- Create: `server/lib/voice/speak.ts`
- Test: `server/lib/voice/speak.test.ts`

**Interfaces:**
- Consumes: `breezeSpeak`, `BreezeStream`, `BreezeError` (Task 3); `breezeQueue`, `QueuePriority` (Task 4); `VoicePresetDTO` (Task 1)
- Produces:
  - `type SpeakChunk = { kind: 'begin'; sampleRate: number } | { kind: 'pcm'; bytes: Uint8Array }`
  - `interface SpeakDeps { baseURL: () => Promise<string>; queue?: BreezeQueue; speakFn?: typeof breezeSpeak }`
  - `createSpeaker(deps: SpeakDeps): (text: string, preset: VoicePresetDTO, priority: QueuePriority, signal?: AbortSignal) => AsyncIterable<SpeakChunk>`
  - `speakWithPreset` — app-wired singleton with the same call signature
  - `pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer`
  - `collectPcm(chunks: AsyncIterable<SpeakChunk>): Promise<{ pcm: Buffer; sampleRate: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/voice/speak.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createSpeaker, pcmToWav, collectPcm, type SpeakChunk } from './speak'
import { createBreezeQueue } from './breeze-queue'
import { BreezeError } from './breeze'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const design: VoicePresetDTO = {
  id: 'p1', name: 'neutral', instruction: 'A neutral, low-key man.', cfgScale: 4, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refStorageKey: null, refText: null,
  refDurationMs: null, maxSegmentChars: 200, isDefault: true
}

function fakeSpeak(chunks: number[][], sampleRate = 24000) {
  return vi.fn(async () => ({
    sampleRate,
    chunks: (async function* () { for (const c of chunks) yield new Uint8Array(c) })()
  }))
}

async function drain(it: AsyncIterable<SpeakChunk>) {
  const out: SpeakChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('createSpeaker', () => {
  it('emits a begin chunk carrying the sample rate, then pcm chunks in order', async () => {
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue: createBreezeQueue(),
      speakFn: fakeSpeak([[1, 2], [3]], 16000) as never
    })
    const out = await drain(speaker('hi', design, 'agent'))
    expect(out[0]).toEqual({ kind: 'begin', sampleRate: 16000 })
    expect(out.slice(1).map(c => [...(c as { bytes: Uint8Array }).bytes])).toEqual([[1, 2], [3]])
  })

  it('maps the preset onto the Breeze request fields', async () => {
    const speakFn = fakeSpeak([[1]])
    const speaker = createSpeaker({ baseURL: async () => 'http://rig:8880', queue: createBreezeQueue(), speakFn: speakFn as never })
    await drain(speaker('hello there', design, 'agent'))
    expect(speakFn.mock.calls[0][1]).toMatchObject({
      text: 'hello there', instruction: 'A neutral, low-key man.', cfgScale: 4, seed: 11, topP: 1.0, topK: 50
    })
  })

  // The slot must be held for the WHOLE stream, not just until headers — otherwise a
  // second caller starts generating while the first is still receiving audio, and the
  // rig 409s.
  it('holds the queue slot until the stream is fully drained', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: fakeSpeak([[1], [2], [3]]) as never
    })
    const it = speaker('hi', design, 'agent')[Symbol.asyncIterator]()
    await it.next()                       // begin
    await it.next()                       // first pcm chunk
    let granted = false
    void queue.acquire('agent').then(r => { granted = true; r() })
    await new Promise(r => setTimeout(r, 0))
    expect(granted).toBe(false)           // still held mid-stream
    await it.next(); await it.next(); await it.next()  // drain to completion
    await new Promise(r => setTimeout(r, 0))
    expect(granted).toBe(true)
  })

  it('releases the slot when the stream throws', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: vi.fn(async () => ({
        sampleRate: 24000,
        chunks: (async function* () { throw new BreezeError('truncated', 'no audio') })()
      })) as never
    })
    await expect(drain(speaker('hi', design, 'agent'))).rejects.toMatchObject({ code: 'truncated' })
    const r = await queue.acquire('agent')
    expect(typeof r).toBe('function')
    r()
  })

  it('releases the slot when breezeSpeak itself rejects', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: vi.fn(async () => { throw new BreezeError('http', 'boom') }) as never
    })
    await expect(drain(speaker('hi', design, 'agent'))).rejects.toMatchObject({ code: 'http' })
    const r = await queue.acquire('agent')
    expect(typeof r).toBe('function')
    r()
  })
})

describe('pcmToWav', () => {
  it('prepends a 44-byte RIFF header describing mono s16le at the given rate', () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]), 24000)
    expect(wav.length).toBe(44 + 4)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1)        // channels
    expect(wav.readUInt32LE(24)).toBe(24000)    // sample rate
    expect(wav.readUInt16LE(34)).toBe(16)       // bits per sample
    expect(wav.readUInt32LE(40)).toBe(4)        // data chunk size
    expect(wav.readUInt32LE(4)).toBe(36 + 4)    // RIFF size
  })
})

describe('collectPcm', () => {
  it('concatenates pcm chunks and reports the sample rate from begin', async () => {
    async function* src(): AsyncIterable<SpeakChunk> {
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([1, 2]) }
      yield { kind: 'pcm', bytes: new Uint8Array([3]) }
    }
    const { pcm, sampleRate } = await collectPcm(src())
    expect([...pcm]).toEqual([1, 2, 3])
    expect(sampleRate).toBe(24000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/speak.test.ts`
Expected: FAIL — "Failed to resolve import ./speak"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/lib/voice/speak.ts
// Composes: queue slot -> Breeze call -> preset field mapping. The ONLY place that may
// call breezeSpeak, because the queue slot must wrap the whole stream lifetime.
import { Buffer } from 'node:buffer'
import { breezeSpeak, type BreezeRequest } from './breeze'
import { breezeQueue, type BreezeQueue, type QueuePriority } from './breeze-queue'
import { resolveChain } from '../ai/registry/resolve'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

export type SpeakChunk =
  | { kind: 'begin'; sampleRate: number }
  | { kind: 'pcm'; bytes: Uint8Array }

export interface SpeakDeps {
  baseURL: () => Promise<string>
  queue?: BreezeQueue
  speakFn?: typeof breezeSpeak
}

export function presetToRequest(text: string, p: VoicePresetDTO, refAudio: Uint8Array | null): BreezeRequest {
  return {
    text,
    instruction: p.instruction,
    cfgScale: p.cfgScale,
    seed: p.seed,
    temperature: p.temperature,
    topP: p.topP,
    topK: p.topK,
    refAudio: refAudio ? { bytes: refAudio, filename: 'reference.wav' } : null,
    refText: p.refText
  }
}

export function createSpeaker(deps: SpeakDeps) {
  const queue = deps.queue ?? breezeQueue
  const speakFn = deps.speakFn ?? breezeSpeak

  return async function* speak(
    text: string,
    preset: VoicePresetDTO,
    priority: QueuePriority,
    signal?: AbortSignal,
    refAudio: Uint8Array | null = null
  ): AsyncIterable<SpeakChunk> {
    const release = await queue.acquire(priority, signal)
    try {
      const base = await deps.baseURL()
      const stream = await speakFn(base, presetToRequest(text, preset, refAudio), signal)
      yield { kind: 'begin', sampleRate: stream.sampleRate }
      for await (const bytes of stream.chunks) yield { kind: 'pcm', bytes }
    } finally {
      // Runs on normal completion, on throw, AND when the consumer breaks out of the
      // for-await early (generator .return()) — all three must free the rig.
      release()
    }
  }
}

/** App-wired speaker: base URL from the registry's tts assignment (first entry wins). */
export const speakWithPreset = createSpeaker({
  baseURL: async () => {
    const chain = await resolveChain('tts')
    const head = chain[0]
    if (!head?.baseURL) throw new Error('No TTS model configured — set one in Settings → Models')
    // The registry stores OpenAI-style base URLs ending in /v1; Breeze's own path already
    // includes /v1, so strip it to get the service root.
    return head.baseURL.replace(/\/$/, '').replace(/\/v1$/, '')
  }
})

export async function collectPcm(chunks: AsyncIterable<SpeakChunk>): Promise<{ pcm: Buffer; sampleRate: number }> {
  let sampleRate = 24000
  const parts: Uint8Array[] = []
  for await (const c of chunks) {
    if (c.kind === 'begin') sampleRate = c.sampleRate
    else parts.push(c.bytes)
  }
  return { pcm: Buffer.concat(parts), sampleRate }
}

/** Wrap headerless PCM (mono / s16le) in a 44-byte RIFF header for download/playback. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2          // mono * 16-bit
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)             // fmt chunk size
  header.writeUInt16LE(1, 20)              // PCM
  header.writeUInt16LE(1, 22)              // channels
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)              // block align
  header.writeUInt16LE(16, 34)             // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, Buffer.from(pcm)])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/voice/speak.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/speak.ts server/lib/voice/speak.test.ts
git commit -m "feat(voice): speaker composing queue slot, Breeze call and preset

The queue slot wraps the whole stream lifetime, not just the headers —
releasing at headers would let a second caller start generating while
the first is still receiving, which the rig answers with 409.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 6: `voice_presets` table + migration seeding the eight starters

**Files:**
- Create: `server/db/schema/voice-presets.ts`
- Modify: `server/db/schema/index.ts`
- Create: `server/db/migrations/00XX_<generated>.sql` (drizzle-kit names it)

**Interfaces:**
- Consumes: nothing
- Produces: `voicePresets` Drizzle table; `VoicePresetRow = typeof voicePresets.$inferSelect`

- [ ] **Step 1: Write the schema**

```ts
// server/db/schema/voice-presets.ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, real, index, uniqueIndex, check } from 'drizzle-orm/pg-core'

// A Breeze voice. Mode (plain|design|clone|direction) is DERIVED from which fields are
// populated — see shared/types/voice-presets.ts presetMode(). Deliberately not a column:
// a stored mode can contradict the fields it claims to describe.
export const voicePresets = pgTable('voice_presets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  instruction: text('instruction'),
  cfgScale: real('cfg_scale').notNull().default(4),
  seed: integer('seed').notNull().default(42),
  temperature: real('temperature').notNull().default(0.9),
  topP: real('top_p').notNull().default(1),
  topK: integer('top_k').notNull().default(50),
  refStorageKey: text('ref_storage_key'),
  refText: text('ref_text'),
  refDurationMs: integer('ref_duration_ms'),
  maxSegmentChars: integer('max_segment_chars').notNull().default(200),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  uniqueIndex('voice_presets_name_key').on(t.name),
  // Exactly one default. The voice cookie resolves to "the default preset" whenever its
  // stored id is missing (deleted preset, fresh browser), so losing the default leaves
  // the agent with nothing to speak with.
  uniqueIndex('voice_presets_one_default').on(t.isDefault).where(sql`is_default`),
  index('voice_presets_name_idx').on(t.name),
  // cfg_scale > 1 needs an instruction: without one Breeze has no negative prompt and
  // answers 500 with an opaque body. Enforced here because a bad row is not a
  // mis-render, it is every utterance from that preset failing.
  check('voice_presets_cfg_needs_instruction',
    sql`${t.cfgScale} <= 1 OR (${t.instruction} IS NOT NULL AND btrim(${t.instruction}) <> '')`),
  check('voice_presets_cfg_positive', sql`${t.cfgScale} > 0`),
  // A reference without its transcript is the same class of guaranteed-500.
  check('voice_presets_ref_needs_text',
    sql`${t.refStorageKey} IS NULL OR (${t.refText} IS NOT NULL AND btrim(${t.refText}) <> '')`)
])

export type VoicePresetRow = typeof voicePresets.$inferSelect
```

- [ ] **Step 2: Export from the schema index**

Append to `server/db/schema/index.ts`:

```ts
export * from './voice-presets'
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/00XX_*.sql` creating `voice_presets` with the three checks and two unique indexes.

- [ ] **Step 4: Append the seed to the generated migration**

Open the newly generated `.sql` and append (keep the generated DDL above it untouched):

```sql
--> statement-breakpoint
-- The eight starter voices from the rig's handoff package, all reference-free voice
-- design at seed 11 / cfg 4. Seeded rather than shipped as read-only built-ins so they
-- can be retuned in place; prod must deploy into a state where the agent has a voice,
-- and the cookie migration needs a valid target to point at.
INSERT INTO "voice_presets" (name, instruction, cfg_scale, seed, temperature, top_p, top_k, max_segment_chars, is_default) VALUES
  ('neutral-lowkey',  'A neutral, low-key man. Understated and unobtrusive, no performance, just clear.', 4, 11, 0.9, 1, 50, 200, true),
  ('warm-woman',      'A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.', 4, 11, 0.9, 1, 50, 200, false),
  ('bright-man',      'A bright, energetic young man. Quick, friendly, upbeat conversational pace.', 4, 11, 0.9, 1, 50, 200, false),
  ('deep-narrator',   'A deep, calm older man with measured authority. Documentary narrator gravitas.', 4, 11, 0.9, 1, 50, 200, false),
  ('crisp-anchor',    'A crisp, precise professional woman. Newsreader clarity, neutral and articulate.', 4, 11, 0.9, 1, 50, 200, false),
  ('dry-laidback',    'A laid-back American man with a dry, understated delivery and subtle humour.', 4, 11, 0.9, 1, 50, 200, false),
  ('latenight-radio', 'A gravelly, warm middle-aged man. Intimate late-night radio host, relaxed and smooth.', 4, 11, 0.9, 1, 50, 200, false),
  ('light-assistant', 'A light, upbeat woman with an approachable helpful tone. Friendly assistant energy.', 4, 11, 0.9, 1, 50, 200, false);
```

- [ ] **Step 5: Apply and verify the migration**

Run: `pnpm db:migrate`
Then verify the seed and that a constraint actually bites:

```bash
psql "$DATABASE_URL" -c "select name, is_default from voice_presets order by name;"
# Expected: 8 rows, neutral-lowkey is_default = t

psql "$DATABASE_URL" -c "insert into voice_presets (name, cfg_scale) values ('bad', 4);"
# Expected: ERROR ... violates check constraint "voice_presets_cfg_needs_instruction"
```

- [ ] **Step 6: Run the gates**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/db/schema/voice-presets.ts server/db/schema/index.ts server/db/migrations/
git commit -m "feat(voice): voice_presets table seeded with the eight starters

Mode is derived, not stored. The cfg/instruction and ref/ref_text pairs
are DB checks rather than app validation: a bad row is not a mis-render,
it is every utterance from that preset returning an opaque 500.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 7: Preset service — CRUD + calibration

**Files:**
- Create: `server/services/voice-presets.ts`
- Test: `server/services/voice-presets.db.test.ts` (DB-backed — **must** carry the `.db.test.ts` suffix)
- Test: `server/services/voice-presets-calibrate.test.ts` (pure, no DB)

**Interfaces:**
- Consumes: `voicePresets` (Task 6); `VoicePresetDTO` (Task 1); `speakWithPreset`, `SpeakChunk` (Task 5); `BreezeError` (Task 2)
- Produces:
  - `listPresets(): Promise<VoicePresetDTO[]>`
  - `getPreset(id: string): Promise<VoicePresetDTO | null>`
  - `getDefaultPreset(): Promise<VoicePresetDTO>`
  - `resolvePreset(id: string | null | undefined): Promise<VoicePresetDTO>` — falls back to default
  - `createPreset(input: PresetInput): Promise<VoicePresetDTO>`
  - `updatePreset(id: string, input: Partial<PresetInput>): Promise<VoicePresetDTO>`
  - `deletePreset(id: string): Promise<void>`
  - `calibrateMaxSegmentChars(preset, probe): Promise<number>`
  - `interface PresetInput { name, instruction, cfgScale, seed, temperature, topP, topK, refStorageKey, refText, refDurationMs, isDefault }` (all optional except `name`)

- [ ] **Step 1: Write the failing calibration test**

```ts
// server/services/voice-presets-calibrate.test.ts
import { describe, it, expect, vi } from 'vitest'
import { calibrateMaxSegmentChars } from './voice-presets'
import { BreezeError } from '../lib/voice/breeze'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

const clone: VoicePresetDTO = {
  id: 'p', name: 'tony', instruction: 'Warmly.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: 'k', refText: 'transcript', refDurationMs: 8000,
  maxSegmentChars: 200, isDefault: false
}
const design: VoicePresetDTO = { ...clone, refStorageKey: null, refText: null, refDurationMs: null }

describe('calibrateMaxSegmentChars', () => {
  it('skips the probe entirely for a reference-free preset', async () => {
    const probe = vi.fn()
    expect(await calibrateMaxSegmentChars(design, probe)).toBe(200)
    expect(probe).not.toHaveBeenCalled()
  })

  it('returns 200 when the 200-char probe succeeds', async () => {
    const probe = vi.fn(async () => {})
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(200)
    expect(probe).toHaveBeenCalledTimes(1)
    expect((probe.mock.calls[0][0] as string).length).toBe(200)
  })

  it('falls back to 100 when the 200-char probe truncates', async () => {
    const probe = vi.fn(async (text: string) => {
      if (text.length > 100) throw new BreezeError('truncated', 'no audio')
    })
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(100)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('returns 100 as the floor when both probes truncate', async () => {
    const probe = vi.fn(async () => { throw new BreezeError('truncated', 'no audio') })
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(100)
  })

  // A busy rig or a network blip is not evidence about the prompt budget. Narrowing the
  // cap on it would silently degrade a good preset.
  it('rethrows a non-truncation error instead of narrowing the cap', async () => {
    const probe = vi.fn(async () => { throw new BreezeError('busy', 'in flight') })
    await expect(calibrateMaxSegmentChars(clone, probe)).rejects.toMatchObject({ code: 'busy' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/services/voice-presets-calibrate.test.ts`
Expected: FAIL — "Failed to resolve import ./voice-presets"

- [ ] **Step 3: Write the service**

```ts
// server/services/voice-presets.ts
import { asc, eq } from 'drizzle-orm'
import { useDb } from '../db'
import { voicePresets, type VoicePresetRow } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { storage } from '../utils/storage'
import { BreezeError } from '../lib/voice/breeze'
import { speakWithPreset, collectPcm } from '../lib/voice/speak'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

const DEFAULT_MAX_SEGMENT_CHARS = 200
const FALLBACK_MAX_SEGMENT_CHARS = 100

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
   *  can write it back through the same update path. */
  maxSegmentChars?: number
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

/** The agent's resolution point: an unknown or absent id falls back to the default rather
 *  than failing the turn. A preset can be deleted while a cookie still names it. */
export async function resolvePreset(id: string | null | undefined): Promise<VoicePresetDTO> {
  if (id) {
    const hit = await getPreset(id)
    if (hit) return hit
  }
  return getDefaultPreset()
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
  publishChange({ resource: 'voicePreset', action: 'created', id: row!.id })
  return toDTO(row!)
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

/** Load a preset's reference clip bytes from storage, or null for a design preset. */
export async function loadReferenceBytes(preset: VoicePresetDTO): Promise<Uint8Array | null> {
  if (!preset.refStorageKey) return null
  const { stream } = await storage().get(preset.refStorageKey)
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c))
  return new Uint8Array(Buffer.concat(parts))
}
```

- [ ] **Step 4: Register the live-bus resource name**

Add `'voicePreset'` to the `ResourceName` union in `shared/types/live.ts` (after `'graph'`).

That is the only change needed. `OVERRIDES` in `app/utils/live-dispatch.ts` is a
`Partial<Record<ResourceName, …>>`, so the default behaviour (invalidate the resource's detail +
list query keys) applies automatically — add an entry there only if presets ever need to
invalidate an extra key, which they do not.

- [ ] **Step 5: Run the calibration test to verify it passes**

Run: `pnpm vitest run server/services/voice-presets-calibrate.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: Write the DB-backed CRUD test**

```ts
// server/services/voice-presets.db.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useDb } from '../db'
import { voicePresets } from '../db/schema'
import { eq, ne } from 'drizzle-orm'
import { createPreset, updatePreset, deletePreset, getDefaultPreset, resolvePreset, listPresets } from './voice-presets'

describe('voice-presets service', () => {
  beforeEach(async () => {
    // Keep the seeded default; drop anything a previous run created.
    await useDb().delete(voicePresets).where(ne(voicePresets.name, 'neutral-lowkey'))
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
    const p = await createPreset({ name: 'test-default', instruction: 'A calm man.', isDefault: true })
    expect((await getDefaultPreset()).id).toBe(p.id)
    const defaults = await useDb().select().from(voicePresets).where(eq(voicePresets.isDefault, true))
    expect(defaults).toHaveLength(1)
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
```

- [ ] **Step 7: Run the DB test**

Run: `pnpm test:db server/services/voice-presets.db.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 8: Run the gates**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (the `.db.test.ts` file is excluded from `pnpm test` by design)

- [ ] **Step 9: Commit**

```bash
git add server/services/voice-presets.ts server/services/voice-presets*.test.ts server/utils/live-bus.ts app/utils/live-dispatch.ts
git commit -m "feat(voice): preset service with prompt-budget calibration

Clone-backed presets are measured against the agent's segment cap rather
than assumed safe: the overrun is a 200 with an empty body, so it cannot
be caught at call time. Only a truncation narrows the cap — a busy rig is
not evidence about the prompt budget.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 8: Re-point the TTS provider contract onto presets; delete the failover chain

**Files:**
- Modify: `server/lib/voice/providers/types.ts`
- Modify: `server/lib/voice/providers/index.ts`
- Delete: `server/lib/voice/providers/tts-openai.ts`, `test/tts-openai.test.ts`
- Rewrite: `server/lib/voice/tts-failover.ts` → delete file; replace usage with `speakWithPreset`
- Delete: `server/lib/voice/tts-failover.test.ts`, `server/lib/voice/orchestrator-tts-provider.test.ts` (rewrite as below)
- Delete: `server/api/voice/voices.get.ts`
- Create: `server/api/voice/presets.get.ts`
- Modify: `server/lib/voice/pipeline.ts`, `server/lib/voice/orchestrator.ts`, `server/lib/voice/tuning.ts`
- Test: `server/lib/voice/pipeline.test.ts` (modify), `server/lib/voice/orchestrator-speakable.test.ts` (modify)

**Interfaces:**
- Consumes: `SpeakChunk`, `speakWithPreset` (Task 5); `VoicePresetDTO`, `presetMode` (Task 1); `resolvePreset`, `loadReferenceBytes` (Task 7)
- Produces:
  - `TtsProvider.synthesize(text: string, opts: { preset: VoicePresetDTO; refAudio?: Uint8Array | null; signal?: AbortSignal }): AsyncIterable<SpeakChunk>`
  - `VoiceEvent` gains `{ type: 'audio-begin'; segmentId: number; sampleRate: number }` and `{ type: 'audio-end'; segmentId: number }`
  - `TurnDeps.preset: VoicePresetDTO` replaces `TurnDeps.voice` + `TurnDeps.ttsProvider`
  - `SpeechPipelineDeps.onChunk(c: SpeakChunk)` replaces `onAudio(bytes)`

- [ ] **Step 1: Write the failing pipeline test**

Replace the `provider`/`voice` wiring in `server/lib/voice/pipeline.test.ts` and add:

```ts
// server/lib/voice/pipeline.test.ts — additions
import { SpeechPipeline } from './pipeline'
import type { SpeakChunk } from './speak'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, isDefault: true
}

describe('SpeechPipeline — streaming chunks', () => {
  it('emits chunks as they arrive, not buffered to the end of the segment', async () => {
    const seen: string[] = []
    let releaseSecond!: () => void
    const gate = new Promise<void>(r => { releaseSecond = r })
    const synthesize = async function* (): AsyncIterable<SpeakChunk> {
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([1]) }
      await gate
      yield { kind: 'pcm', bytes: new Uint8Array([2]) }
    }
    const p = new SpeechPipeline({
      synthesize: synthesize as never,
      preset,
      signal: new AbortController().signal,
      concurrency: 1,
      onChunk: (c) => { seen.push(c.kind === 'begin' ? 'begin' : String(c.bytes[0])) }
    })
    const done = p.push('hello').then(() => p.drain())
    await new Promise(r => setTimeout(r, 0))
    // If the pipeline buffered the segment, NOTHING would have been emitted yet.
    expect(seen).toEqual(['begin', '1'])
    releaseSecond()
    await done
    expect(seen).toEqual(['begin', '1', '2'])
  })

  it('drops a segment whose synthesis throws and keeps the turn going', async () => {
    const seen: string[] = []
    let call = 0
    const synthesize = async function* (): AsyncIterable<SpeakChunk> {
      call++
      if (call === 1) throw new Error('truncated')
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([9]) }
    }
    const p = new SpeechPipeline({
      synthesize: synthesize as never, preset, signal: new AbortController().signal,
      concurrency: 1, onChunk: (c) => seen.push(c.kind === 'begin' ? 'begin' : String(c.bytes[0]))
    })
    await p.push('one')
    await p.push('two')
    await p.drain()
    expect(seen).toEqual(['begin', '9'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/pipeline.test.ts`
Expected: FAIL — `onChunk` is not a known option; `preset` is not a known option

- [ ] **Step 3: Rewrite the provider contract**

```ts
// server/lib/voice/providers/types.ts
import type { SpeakChunk } from '../speak'
import type { VoicePresetDTO } from '../../../../shared/types/voice-presets'

export interface SttProvider {
  transcribe(audio: Uint8Array, opts?: { language?: string; signal?: AbortSignal }): Promise<string>
}

/**
 * Breeze is the only TTS engine — there is no failover, and no `provider` label, because
 * a voice is no longer an enum a provider hands us. It is a preset we author.
 */
export interface TtsProvider {
  synthesize(text: string, opts: {
    preset: VoicePresetDTO
    /** Reference clip bytes for clone/direction presets; null for design/plain. */
    refAudio?: Uint8Array | null
    signal?: AbortSignal
  }): AsyncIterable<SpeakChunk>
}
```

```ts
// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import type { SttProvider } from './types'
import type { ResolvedModel } from '../../ai/registry/types'

export function sttFromModel(m: ResolvedModel): SttProvider {
  return whisperStt({ baseURL: (m.baseURL ?? '').replace(/\/$/, ''), model: m.modelId, apiKey: m.apiKey ?? undefined })
}
// ttsFromModel is GONE. TTS no longer resolves per-model: see server/lib/voice/speak.ts.
```

- [ ] **Step 4: Delete the failover chain and the OpenAI TTS provider**

```bash
git rm server/lib/voice/providers/tts-openai.ts test/tts-openai.test.ts \
       server/lib/voice/tts-failover.ts server/lib/voice/tts-failover.test.ts \
       server/lib/voice/orchestrator-tts-provider.test.ts \
       server/api/voice/voices.get.ts
```

- [ ] **Step 5: Add the presets endpoint that replaces `/api/voice/voices`**

```ts
// server/api/voice/presets.get.ts
import { listPresets } from '../../services/voice-presets'

export default defineEventHandler(async () => ({ presets: await listPresets() }))
```

- [ ] **Step 6: Re-point the pipeline onto chunks**

In `server/lib/voice/pipeline.ts`:
- Replace `voice: string` and `provider?: string | null` in `SpeechPipelineDeps` with `preset: VoicePresetDTO` and `refAudio?: Uint8Array | null`.
- Replace `onAudio: (bytes: Uint8Array) => void` with `onChunk: (c: SpeakChunk) => void`.
- Change `SegmentResult` from `Uint8Array[] | undefined` to an emit-as-you-go model: `start()` no longer collects into an array.

Replace the `start`/`drainOne` pair with:

```ts
type SegmentResult = SpeakChunk[] | undefined

private start(text: string): Promise<SegmentResult> {
  this.deps.onSpeaking?.()
  const run = async (): Promise<SpeakChunk[]> => {
    const out: SpeakChunk[] = []
    for await (const c of this.deps.synthesize(text, {
      preset: this.deps.preset, refAudio: this.deps.refAudio, signal: this.deps.signal
    })) {
      // Concurrency is pinned to 1 for Breeze, so the oldest in-flight segment IS the
      // one being drained — emit immediately rather than collecting. With concurrency
      // > 1 this would scramble segment order; see the cap in tuning.ts.
      if (!this.deps.signal.aborted) this.deps.onChunk(c)
      out.push(c)
    }
    return out
  }
  return run().catch((err: unknown) => {
    if ((err as Error)?.name !== 'AbortError') {
      console.error('[voice] segment synthesis failed, dropping segment:', err)
    }
    return undefined
  })
}

private async drainOne(): Promise<void> {
  const p = this.queue.shift()
  if (!p) return
  await p
  this.firstSegmentDrained = true
}
```

Add a guard in the constructor:

```ts
constructor(private deps: SpeechPipelineDeps) {
  this.concurrency = deps.concurrency ?? 1
  // Emission happens inside start() now, so >1 in flight would interleave two segments'
  // audio. Breeze is single-request anyway; this makes the coupling explicit rather than
  // leaving a latent reordering bug for whoever raises the tuning constant.
  if (this.concurrency !== 1) throw new Error('SpeechPipeline: Breeze is single-request; concurrency must be 1')
}
```

- [ ] **Step 7: Pin the tuning constant**

In `server/lib/voice/tuning.ts`, replace the `pipelineConcurrency: 3` entry and its comment:

```ts
  // pipelineConcurrency: PINNED AT 1. Breeze serves one inference at a time (409
  // otherwise), and pipeline.ts now emits chunks as they arrive rather than buffering a
  // whole segment — so >1 in flight would both 409 the rig and interleave two segments'
  // audio. SpeechPipeline throws if this is ever raised.
  tts:     { sentenceMinChars: 140, sentenceMaxChars: 200, firstSegmentMaxChars: 60, pipelineConcurrency: 1 },
```

- [ ] **Step 8: Re-point the orchestrator**

In `server/lib/voice/orchestrator.ts`:

Extend `VoiceEvent`:

```ts
export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[] }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'audio-begin'; segmentId: number; sampleRate: number }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'audio-end'; segmentId: number }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }
```

In `TurnDeps`, replace `voice: string` and `ttsProvider?: string | null` with:

```ts
  /** The voice to speak in. Resolved at the WS boundary (ws.ts) from the client's
   *  cookie-backed preset id, falling back to the default preset. */
  preset: VoicePresetDTO
  /** Reference clip bytes for a clone/direction preset; null for design/plain. */
  refAudio?: Uint8Array | null
```

In `handleTurn`, replace the `SpeechPipeline` construction and the chunker cap:

```ts
  // The segment cap is per-preset: a clone-backed preset carries its reference in every
  // prompt, so it may not be safe at the default 200 (see calibrateMaxSegmentChars).
  const maxChars = Math.min(VOICE_TUNING.tts.sentenceMaxChars, deps.preset.maxSegmentChars)
  const chunker = new SpeechChunker(
    Math.min(VOICE_TUNING.tts.sentenceMinChars, maxChars),
    maxChars,
    Math.min(VOICE_TUNING.tts.firstSegmentMaxChars, maxChars)
  )

  let segmentId = 0
  const pipeline = new SpeechPipeline({
    synthesize: (text, opts) => deps.tts.synthesize(text, opts),
    preset: deps.preset,
    refAudio: deps.refAudio,
    signal: deps.signal,
    concurrency: VOICE_TUNING.tts.pipelineConcurrency,
    onSpeaking: () => deps.emit({ type: 'state', state: 'speaking' }),
    onChunk: (c) => {
      if (c.kind === 'begin') {
        segmentId++
        deps.emit({ type: 'audio-begin', segmentId, sampleRate: c.sampleRate })
      } else {
        deps.emit({ type: 'audio', bytes: c.bytes })
      }
    }
  })
```

And after `await pipeline.drain()` (find the existing call near the end of the turn), emit the closing frame:

```ts
  if (deps.speak && segmentId > 0) deps.emit({ type: 'audio-end', segmentId })
```

- [ ] **Step 9: Wire `ws.ts`**

In `server/api/voice/ws.ts`:
- Replace `import { ttsSynth } from '../../lib/voice/tts-failover'` with
  `import { speakWithPreset } from '../../lib/voice/speak'`.
- Replace the `tts` const with:

```ts
// TTS: Breeze only. No failover chain — one engine, resolved from the registry's tts
// assignment inside speakWithPreset.
const tts: TtsProvider = {
  synthesize: (text, opts) => speakWithPreset(text, opts.preset, 'agent', opts.signal, opts.refAudio ?? null)
}
```

- In `ConnState`, replace `voice: string` and `ttsProvider: string | null` with `presetId: string | null`.
- In `open`, seed `presetId: null`.
- Replace the `msg.type === 'voice'` branch with:

```ts
      if (msg.type === 'preset') {
        s.presetId = typeof msg.presetId === 'string' && msg.presetId ? msg.presetId : null
        return
      }
```

- In both `turn = …` closures, resolve the preset and its reference before calling:

```ts
        turn = async (signal, emit, context) => {
          const preset = await resolvePreset(s.presetId)
          const refAudio = await loadReferenceBytes(preset)
          return handleTurn(text, s.history, { tts, preset, refAudio, speak, context, modelDefId: s.model, buildMemoryContext, requestApproval, attachments, signal, emit })
        }
```

(and the matching `handleUtterance` call — same two lines, `speak: true`).

- Add the imports: `import { resolvePreset, loadReferenceBytes } from '../../services/voice-presets'`.
- In the `emit` handler, forward the new frames — `audio` stays binary, the two new ones are JSON:

```ts
          if (e.type === 'audio') peer.send(e.bytes)
```

(no change needed — `audio-begin`/`audio-end` fall through to the JSON branch automatically.)

- [ ] **Step 10: Run the tests**

Run: `pnpm vitest run server/lib/voice/`
Expected: PASS. Fix any remaining references to `voice`/`ttsProvider` in
`orchestrator-speakable.test.ts`, `orchestrator-embed.test.ts`, `orchestrator-usage.test.ts`,
`orchestrator-attachments.test.ts` by replacing `voice: 'x', ttsProvider: null` in their deps
objects with `preset` (use the `preset` fixture literal from Step 1).

- [ ] **Step 11: Run the gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor(voice): Breeze-only TTS — delete the failover chain

A voice stops being a provider-supplied enum and becomes a preset we
author, so pinChainToProvider, the voices aggregation and openAiTts all
go rather than sit inert.

Deleting failover is what lets per-segment buffering go: createTtsSynth
collected a whole segment so a failing provider could be retried, and
that buffer is precisely what would have thrown away the streaming win.
Concurrency is pinned to 1 and SpeechPipeline throws if it is raised.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 9: Client PCM playback + preset picker + cookie migration

**Files:**
- Modify: `app/composables/useVoiceSettings.ts`
- Modify: `app/composables/useVoiceSettings.test.ts`
- Modify: `app/lib/voice/messages.ts`, `app/lib/voice/messages.test.ts`
- Modify: `app/composables/useVoice.ts`
- Modify: `app/components/voice/SettingsSlideover.vue`

**Interfaces:**
- Consumes: `/api/voice/presets` (Task 8); the `audio-begin`/`audio-end` frames (Task 8)
- Produces: `VoiceUserSettings.presetId: string`; `useVoice().setPreset(id: string)`

- [ ] **Step 1: Write the failing settings-migration test**

Append to `app/composables/useVoiceSettings.test.ts`:

```ts
import { migrateVoiceSettings, VOICE_SETTINGS_DEFAULTS } from './useVoiceSettings'

describe('migrateVoiceSettings — Breeze preset migration', () => {
  it('drops a pre-Breeze provider/voice pair and falls back to the default preset', () => {
    const out = migrateVoiceSettings({ provider: 'chatterbox', voice: 'Gianna.wav' } as never)
    expect(out.presetId).toBe('')
    expect('provider' in out).toBe(false)
    expect('voice' in out).toBe(false)
  })

  it('keeps an already-migrated presetId', () => {
    const out = migrateVoiceSettings({ presetId: 'abc-123' } as never)
    expect(out.presetId).toBe('abc-123')
  })

  it('backfills newly added keys from defaults', () => {
    const out = migrateVoiceSettings({ presetId: 'x' } as never)
    expect(out.playbackRate).toBe(VOICE_SETTINGS_DEFAULTS.playbackRate)
    expect(out.bargeInEnabled).toBe(VOICE_SETTINGS_DEFAULTS.bargeInEnabled)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/composables/useVoiceSettings.test.ts`
Expected: FAIL — `presetId` is undefined

- [ ] **Step 3: Migrate the settings composable**

In `app/composables/useVoiceSettings.ts`, replace the `provider`/`voice` fields:

```ts
export interface VoiceUserSettings {
  /** voice_presets.id. '' means "use the server's default preset" — which is also what
   *  an unknown id resolves to (resolvePreset), so a deleted preset degrades gracefully. */
  presetId: string
  positiveSpeechThreshold: number
  minSpeechMs: number
  redemptionMs: number
  bargeInEnabled: boolean
  playbackRate: number
  micDeviceId: string
}

export const VOICE_SETTINGS_DEFAULTS: VoiceUserSettings = {
  presetId: '',
  positiveSpeechThreshold: 0.5,
  minSpeechMs: 100,
  redemptionMs: 240,
  bargeInEnabled: true,
  playbackRate: 1.0,
  micDeviceId: '',
}
```

And in `migrateVoiceSettings`, before the existing playbackRate migration:

```ts
export function migrateVoiceSettings(stored: Partial<VoiceUserSettings> | null | undefined): VoiceUserSettings {
  const merged = { ...VOICE_SETTINGS_DEFAULTS, ...stored } as VoiceUserSettings & { provider?: string; voice?: string }
  // Pre-Breeze cookies carry {provider, voice} naming a Kokoro/Chatterbox voice that no
  // longer exists on any engine. Drop them; '' resolves to the server's default preset.
  if ('provider' in merged || 'voice' in merged) {
    delete merged.provider
    delete merged.voice
    if (!merged.presetId) merged.presetId = ''
  }
  if (merged.playbackRate === OLD_DEFAULT_PLAYBACK_RATE) {
    merged.playbackRate = VOICE_SETTINGS_DEFAULTS.playbackRate
  }
  return merged
}
```

- [ ] **Step 4: Run the settings test**

Run: `pnpm vitest run app/composables/useVoiceSettings.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing message-mapper test**

Append to `app/lib/voice/messages.test.ts`:

```ts
describe('mapServerMessage — audio framing', () => {
  it('surfaces audio-begin with its sample rate', () => {
    const fx = mapServerMessage({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 } as never, false)
    expect(fx.audioBegin).toEqual({ segmentId: 1, sampleRate: 24000 })
  })
  it('surfaces audio-end', () => {
    const fx = mapServerMessage({ type: 'audio-end', segmentId: 3 } as never, false)
    expect(fx.audioEnd).toBe(3)
  })
})
```

- [ ] **Step 6: Run to verify it fails, then implement**

Run: `pnpm vitest run app/lib/voice/messages.test.ts`
Expected: FAIL — `audioBegin` undefined

In `app/lib/voice/messages.ts`, add `audioBegin?: { segmentId: number; sampleRate: number }` and
`audioEnd?: number` to `MsgEffect`, and add to `mapServerMessage` before the `state` branch:

```ts
  if (m.type === 'audio-begin') {
    return { audioBegin: { segmentId: m.segmentId as number, sampleRate: m.sampleRate as number }, events }
  }
  if (m.type === 'audio-end') {
    return { audioEnd: m.segmentId as number, events }
  }
```

Also widen `ServerMsg` to include the two new `type` values and the `segmentId`/`sampleRate` fields.

Run: `pnpm vitest run app/lib/voice/messages.test.ts` → PASS

- [ ] **Step 7: Replace the client WAV path with PCM scheduling**

In `app/composables/useVoice.ts`:

Replace `enqueueWav` / `playWav` with:

```ts
  // Breeze streams headerless PCM (mono / s16le) as it generates, so playback starts on
  // the first chunk instead of waiting for a whole segment. decodeAudioData cannot be
  // used — it needs a container — and its old `catch { /* skip undecodable */ }` swallowed
  // exactly the failure we most need to see.
  //
  // Scheduling uses the AudioContext clock, NOT the 'ended' event: 'ended' fires late and
  // leaves audible gaps between chunks.
  let pcmSampleRate = 24000
  let carry = new Uint8Array(0)

  function onAudioBegin(sampleRate: number) {
    pcmSampleRate = sampleRate
    carry = new Uint8Array(0)
  }

  /** s16le -> Float32 in [-1, 1] */
  function decodePcm(bytes: Uint8Array): Float32Array {
    const n = bytes.byteLength >> 1
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return out
  }

  function enqueuePcm(data: ArrayBuffer, epoch: number) {
    if (!audioCtx || !outAnalyser || epoch !== playEpoch) return
    // A 16-bit sample must never be split across chunk boundaries.
    const incoming = new Uint8Array(data)
    let bytes: Uint8Array
    if (carry.length) {
      bytes = new Uint8Array(carry.length + incoming.length)
      bytes.set(carry, 0); bytes.set(incoming, carry.length)
    } else {
      bytes = incoming
    }
    const usable = bytes.byteLength - (bytes.byteLength % 2)
    carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable)
    if (usable === 0) return

    const samples = decodePcm(bytes.subarray(0, usable))
    const buf = audioCtx.createBuffer(1, samples.length, pcmSampleRate)
    buf.copyToChannel(samples, 0)
    const node = audioCtx.createBufferSource()
    node.buffer = buf
    node.playbackRate.value = settings.value.playbackRate
    node.connect(outAnalyser)
    // Never schedule in the past, or chunks overlap and click.
    const at = Math.max(audioCtx.currentTime + 0.02, playCursor)
    node.start(at)
    playCursor = at + buf.duration / settings.value.playbackRate
    sources.push(node)
    node.onended = () => {
      sources = sources.filter(s => s !== node)
      if (!isPlaying() && state.value === 'speaking') state.value = 'idle'
    }
  }
```

Delete the now-unused `decodeChain` variable and its reset in `stopPlayback`, and add `carry = new Uint8Array(0)` to `stopPlayback` instead.

Update `onmessage`:

```ts
    socket.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        state.value = 'speaking'
        enqueuePcm(e.data, playEpoch)
      } else {
        const fx = mapServerMessage(JSON.parse(e.data as string), isPlaying())
        if (fx.audioBegin) onAudioBegin(fx.audioBegin.sampleRate)
        if (fx.delta) pushDelta(fx.delta.role, fx.delta.text)
        // … rest unchanged …
      }
    }
```

Update the `onopen` preset send:

```ts
        const p = desiredPreset ?? settings.value.presetId
        socket.send(JSON.stringify({ type: 'preset', presetId: p }))
```

Replace the `desiredVoice` variable with `let desiredPreset: string | null = null`, and replace the
exported `setVoice` with:

```ts
    setPreset: (presetId: string) => {
      desiredPreset = presetId
      settings.value = { ...settings.value, presetId }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'preset', presetId }))
    },
```

- [ ] **Step 8: Re-point the settings slideover**

In `app/components/voice/SettingsSlideover.vue`, replace the voice picker block:

```ts
// Voice picker — presets authored in /voice, not an enum from a provider.
const { data: presetList } = await useFetch('/api/voice/presets', {
  default: () => ({ presets: [] as { id: string, name: string, instruction: string | null }[] })
})
const voiceItems = computed(() =>
  presetList.value.presets.map(p => ({ label: p.name, value: p.id }))
)
const selectedVoice = computed({
  get: () => settings.value.presetId || (presetList.value.presets[0]?.id ?? ''),
  set: (val: string) => props.voice.setPreset(val),
})
```

Note: `USelectMenu` rejects an empty-string item value (reka-ui), which is why the getter falls back
to the first preset's id rather than `''`.

- [ ] **Step 9: Run the gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(voice): stream PCM into Web Audio; presets replace the voice enum

decodeAudioData is gone along with its silent catch — headerless PCM is
scheduled on the AudioContext clock, so audio starts on the first chunk
rather than at the end of a segment.

Pre-Breeze cookies naming a Kokoro/Chatterbox voice migrate to '' which
resolves to the server's default preset.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 10: Studio API — synthesis, reference upload, preset CRUD routes

**Files:**
- Create: `server/api/voice/speak.post.ts`
- Create: `server/api/voice/reference.post.ts`
- Create: `server/api/voice/presets.post.ts`, `server/api/voice/presets/[id].patch.ts`, `server/api/voice/presets/[id].delete.ts`
- Test: `server/api/voice/speak.test.ts`

**Interfaces:**
- Consumes: `speakWithPreset`, `pcmToWav`, `collectPcm` (Task 5); preset service (Task 7); `sttFromModel` + `withFailover` (existing)
- Produces: `POST /api/voice/speak` (streams PCM, `x-sample-rate` header; `?format=wav` returns a complete WAV), `POST /api/voice/reference` (multipart upload → `{ storageKey, refText, durationMs }`)

- [ ] **Step 1: Write the failing WAV-duration test**

```ts
// server/api/voice/speak.test.ts
import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../../lib/voice/speak'
import { wavDurationMs } from '../../lib/voice/wav'

describe('wavDurationMs', () => {
  it('reads duration from a mono s16le WAV header', () => {
    // 24000 samples @ 24kHz = exactly 1 second
    const wav = pcmToWav(new Uint8Array(24000 * 2), 24000)
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('handles a non-24k rate', () => {
    const wav = pcmToWav(new Uint8Array(16000 * 2), 16000)
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('throws on a non-RIFF payload rather than reporting a bogus duration', () => {
    expect(() => wavDurationMs(Buffer.from('not a wav at all'))).toThrow(/RIFF/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/api/voice/speak.test.ts`
Expected: FAIL — cannot resolve `../../lib/voice/wav`

- [ ] **Step 3: Implement the WAV reader**

```ts
// server/lib/voice/wav.ts
import { Buffer } from 'node:buffer'

/**
 * Duration of a mono/stereo PCM WAV in milliseconds, read from its header.
 * Used to enforce the reference-clip limits: a reference consumes the same prompt
 * budget as the text, so its length is a correctness constraint, not a preference.
 */
export function wavDurationMs(buf: Buffer | Uint8Array): number {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 44 || b.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('Not a RIFF/WAV file')
  }
  const channels = b.readUInt16LE(22)
  const sampleRate = b.readUInt32LE(24)
  const bitsPerSample = b.readUInt16LE(34)
  const dataSize = b.readUInt32LE(40)
  const bytesPerFrame = channels * (bitsPerSample / 8)
  if (!sampleRate || !bytesPerFrame) throw new Error('Malformed WAV header')
  return Math.round((dataSize / bytesPerFrame / sampleRate) * 1000)
}

export const REFERENCE_HARD_LIMIT_MS = 60_000
export const REFERENCE_WARN_LIMIT_MS = 20_000
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/api/voice/speak.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Implement the studio synthesis route**

```ts
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

  try {
    if (body.format === 'wav') {
      const { pcm, sampleRate } = await collectPcm(speakWithPreset(text, preset, 'studio', undefined, refAudio))
      setHeader(event, 'Content-Type', 'audio/wav')
      setHeader(event, 'Content-Disposition', `attachment; filename="${preset.name}.wav"`)
      return pcmToWav(pcm, sampleRate)
    }

    const chunks = speakWithPreset(text, preset, 'studio', undefined, refAudio)
    const iterator = chunks[Symbol.asyncIterator]()
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
      cancel() { void iterator.return?.() }   // frees the queue slot on client disconnect
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
```

- [ ] **Step 6: Implement the reference upload + auto-transcribe route**

```ts
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
```

- [ ] **Step 7: Implement the preset CRUD routes**

```ts
// server/api/voice/presets.post.ts
import { createPreset, calibrateMaxSegmentChars, makeLiveProbe, loadReferenceBytes, updatePreset } from '../../services/voice-presets'
import type { PresetInput } from '../../services/voice-presets'

export default defineEventHandler(async (event) => {
  const body = await readBody<PresetInput>(event)
  if (!body?.name?.trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  const created = await createPreset(body)
  // Calibration costs a rig slot, so only reference-backed presets pay it (design presets
  // run ~40-token prompts and cannot approach the ceiling).
  if (created.refStorageKey) {
    const refAudio = await loadReferenceBytes(created)
    const max = await calibrateMaxSegmentChars(created, makeLiveProbe(created, refAudio))
    if (max !== created.maxSegmentChars) return updatePreset(created.id, { maxSegmentChars: max })
  }
  return created
})
```

```ts
// server/api/voice/presets/[id].patch.ts
import { updatePreset, getPreset, calibrateMaxSegmentChars, makeLiveProbe, loadReferenceBytes } from '../../../services/voice-presets'
import type { PresetInput } from '../../../services/voice-presets'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<PresetInput>>(event)
  const before = await getPreset(id)
  if (!before) throw createError({ statusCode: 404, statusMessage: 'preset not found' })
  const updated = await updatePreset(id, body)
  // Recalibrate only when the reference actually changed — the cap depends on the clip,
  // not on the instruction or the sampling knobs.
  if (updated.refStorageKey && updated.refStorageKey !== before.refStorageKey) {
    const refAudio = await loadReferenceBytes(updated)
    const max = await calibrateMaxSegmentChars(updated, makeLiveProbe(updated, refAudio))
    if (max !== updated.maxSegmentChars) return updatePreset(id, { maxSegmentChars: max })
  }
  return updated
})
```

```ts
// server/api/voice/presets/[id].delete.ts
import { deletePreset } from '../../../services/voice-presets'

export default defineEventHandler(async (event) => {
  await deletePreset(getRouterParam(event, 'id')!)
  return { ok: true }
})
```

Note: the studio UI must never send `maxSegmentChars` itself — it is measured, not chosen. Only
these two calibration write-backs set it.

- [ ] **Step 8: Run the gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(voice): studio synthesis, reference upload and preset routes

Reference clips auto-transcribe through the whisper already in the
registry — Breeze needs ref_text to match the audio exactly, and typing
it by hand is error-prone. Over-length clips are rejected at upload
because the clip shares the prompt budget with the text.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 11: The `/voice` studio page

**Files:**
- Modify: `nuxt.config.ts` (drop the `/voice` redirect)
- Create: `app/composables/useBreezeSpeech.ts`
- Create: `app/pages/voice.vue`
- Create: `app/components/voice/PresetRail.vue`
- Create: `app/components/voice/DesignPane.vue`
- Create: `app/components/voice/SpeakPane.vue`
- Modify: `app/layouts/default.vue` (sidebar entry)

**Interfaces:**
- Consumes: `/api/voice/presets`, `/api/voice/speak`, `/api/voice/reference` (Task 10); `VoicePresetDTO`, `presetMode` (Task 1)
- Produces: `useBreezeSpeech()` → `{ speak(text, presetId), stop(), speaking, ttfaMs, error }`

- [ ] **Step 1: Drop the redirect**

In `nuxt.config.ts`, remove the line:

```ts
    '/voice': { redirect: '/agent' },
```

- [ ] **Step 2: Write the streaming playback composable**

```ts
// app/composables/useBreezeSpeech.ts
// Studio playback. Same PCM-on-the-AudioContext-clock approach as useVoice, but over
// plain fetch rather than the agent socket — an audition must not ride the
// conversation's channel.
export function useBreezeSpeech() {
  const speaking = ref(false)
  const ttfaMs = ref<number | null>(null)
  const error = ref<string | null>(null)
  const ctx = shallowRef<AudioContext | null>(null)
  let playhead = 0
  let abort: AbortController | null = null

  function decodePcm(bytes: Uint8Array): Float32Array {
    const n = bytes.byteLength >> 1
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return out
  }

  function schedule(samples: Float32Array, sampleRate: number) {
    const audio = ctx.value!
    const buf = audio.createBuffer(1, samples.length, sampleRate)
    buf.copyToChannel(samples, 0)
    const src = audio.createBufferSource()
    src.buffer = buf
    src.connect(audio.destination)
    playhead = Math.max(playhead, audio.currentTime + 0.02)
    src.start(playhead)
    playhead += buf.duration
  }

  async function speak(text: string, presetId: string) {
    stop()
    speaking.value = true
    error.value = null
    ttfaMs.value = null
    abort = new AbortController()
    const started = performance.now()
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, presetId }),
        signal: abort.signal
      })
      if (!res.ok || !res.body) throw new Error(await res.text().catch(() => res.statusText))
      const sampleRate = Number(res.headers.get('x-sample-rate')) || 24000
      ctx.value = new AudioContext({ sampleRate })
      playhead = ctx.value.currentTime

      const reader = res.body.getReader()
      let carry = new Uint8Array(0)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        if (ttfaMs.value === null) ttfaMs.value = Math.round(performance.now() - started)
        let bytes: Uint8Array
        if (carry.length) {
          bytes = new Uint8Array(carry.length + value.length)
          bytes.set(carry, 0); bytes.set(value, carry.length)
        } else bytes = value
        const usable = bytes.byteLength - (bytes.byteLength % 2)
        carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable)
        if (usable > 0) schedule(decodePcm(bytes.subarray(0, usable)), sampleRate)
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') error.value = (e as Error).message
    } finally {
      speaking.value = false
      abort = null
    }
  }

  function stop() {
    abort?.abort()
    ctx.value?.close()
    ctx.value = null
    playhead = 0
    speaking.value = false
  }

  onBeforeUnmount(stop)
  return { speak, stop, speaking, ttfaMs, error }
}
```

- [ ] **Step 3: Build the page and its three panes**

Follow the existing Nuxt UI v4 patterns in `app/pages/settings/model-config.vue` and
`app/components/voice/SettingsSlideover.vue`. Required behaviour:

`app/pages/voice.vue` — three-column layout (`PresetRail` | `DesignPane` | `SpeakPane`),
`definePageMeta({ middleware: 'auth' })` matching the other authed pages, `useFetch('/api/voice/presets')`
for the list, and a `selectedId` ref threaded to both panes.

`PresetRail.vue` — list each preset with its name, derived mode badge (`presetMode(p)`), and
`maxSegmentChars` when it is below 200. Buttons: New, Duplicate, Delete (Delete disabled on the
default), and a "Make default" action.

`DesignPane.vue`:
- Instruction `UTextarea` + a `USelectMenu` of the eight starter descriptions that fills it.
- `USlider` for `cfgScale` (1–8, step 0.5), `temperature` (0.1–1.5, step 0.05), `topP` (0.1–1, step 0.05), `topK` (0–100, step 5).
- Seed `UInput` (number) + a dice `UButton` setting `Math.floor(Math.random() * 999999) + 1`.
- **Disable the cfg slider above 1.0 while the instruction is empty** and show the reason —
  this mirrors the DB check and stops a preset that cannot be saved from being composed.
- Seed audition: a "Try 4 seeds" button that calls `/api/voice/speak` once per seed
  **sequentially** (never in parallel — the rig is single-request) with a per-seed play button.
- Reference section: `UFileUpload` for a wav + a record button using `navigator.mediaDevices.getUserMedia`;
  both POST to `/api/voice/reference` and fill an editable `refText` `UTextarea`; show the
  returned `warning` in a `UAlert` when present.

`SpeakPane.vue`:
- `UTextarea` for the text.
- A `USelectMenu` picking a document / memory / conversation, loaded from the existing
  `/api/documents`, `/api/memories` and `/api/conversations` endpoints, whose content fills the textarea.
- Event insert bar: four `UButton`s inserting `(laugh)`, `(sigh)`, `(cough)`, `(clears throat)` at
  the textarea's cursor position.
- Speak button → `useBreezeSpeech().speak()`, showing `ttfaMs` once it lands.
- Download button → `POST /api/voice/speak` with `format: 'wav'`, saved via a blob URL.

- [ ] **Step 4: Add the sidebar entry**

In `app/layouts/default.vue`, add a `/voice` item to the navigation list next to `/agent`, using
`i-lucide-mic-vocal` and the label `Voice`.

- [ ] **Step 5: Run the gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(voice): /voice studio — author presets, read MyMind aloud

Reclaims the /voice route from its redirect to /agent. Replaces the
interim Gradio UI on the rig, which was never a systemd service and did
not survive a reboot.

Seed auditions run sequentially: the rig is single-request, so firing
four at once would 409 three of them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 12: Sanitizer regression guard + cleanup of the dead two-engine world

**Files:**
- Modify: `server/lib/voice/speakable.test.ts` (create if absent)
- Modify: `server/lib/analytics/catalog.ts`
- Modify: `server/api/settings/import-env.post.ts`
- Modify: `README.md`, `docs/model-requirements.md`

**Interfaces:**
- Consumes: `toSpeakable` (existing)
- Produces: nothing

- [ ] **Step 1: Write the failing sanitizer regression test**

```ts
// server/lib/voice/speakable.test.ts — additions
import { describe, it, expect } from 'vitest'
import { toSpeakable } from './speakable'

describe('toSpeakable — Breeze vocal events', () => {
  // toSpeakable rewrites every OTHER bracket form (links, images, emphasis, code), so
  // events surviving is currently incidental. Verified on the rig: all four change the
  // rendered audio, so stripping them would silently remove a real feature.
  it.each(['(laugh)', '(sigh)', '(cough)', '(clears throat)'])('preserves %s', (tag) => {
    expect(toSpeakable(`Well then. ${tag}`)).toContain(tag)
  })

  it('preserves an event at the start of a line', () => {
    expect(toSpeakable('(clears throat) Right.')).toContain('(clears throat)')
  })

  // A markdown link is [label](target) — the link rule must not eat an event that
  // happens to follow a bracketed word.
  it('still strips a real markdown link next to an event', () => {
    expect(toSpeakable('See [the docs](http://x/y) (sigh)')).toBe('See the docs (sigh)')
  })
})
```

- [ ] **Step 2: Run to verify it passes or fails**

Run: `pnpm vitest run server/lib/voice/speakable.test.ts`
Expected: PASS (this pins existing behaviour). If any case FAILS, fix `toSpeakable` so events
survive — do not weaken the test.

- [ ] **Step 3: Re-point the analytics catalog**

In `server/lib/analytics/catalog.ts`, replace the two TTS probe entries:

```ts
    { id: 'breeze-tts', label: 'Breeze TTS 2', source: 'probes', probeService: 'breeze-tts', port: '8880', public: true },
```

(deleting both the `kokoro-tts` and `chatterbox-tts` lines). Update the comment in
`server/lib/analytics/queries.ts:139` that names "Kokoro/Chatterbox TTS" to say "Breeze TTS".

- [ ] **Step 4: Re-point the env import**

In `server/api/settings/import-env.post.ts`, replace the two TTS sources in `SOURCES`:

```ts
  { env: 'AI_TTS_BREEZE', usage: 'tts' },
```

and update the comment above `SOURCES` (it currently says "ttsKokoro/ttsChatterbox both map to tts").

- [ ] **Step 5: Update the two README mentions**

In `README.md`, replace both occurrences of "Kokoro/Chatterbox TTS" with "Breeze TTS 2".

- [ ] **Step 6: Rewrite the rig requirements doc**

Replace `docs/model-requirements.md` wholesale: it currently specifies a two-engine rig
(sections 2 and 3 are Kokoro and Chatterbox). The new content is the Breeze contract —
`POST /v1/audio/speech` multipart, the nine fields, `GET /health` with its ~44s warmup, the
single-request 409, and raw PCM output. Source the details from the spec's "Measured facts"
section rather than restating the package.

- [ ] **Step 7: Run the gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore(voice): retire the two-engine world from probes, env and docs

Pins the vocal events with a regression test: toSpeakable rewrites every
other bracket form, so events surviving is incidental today and one
tidying pass away from silently removing a working feature.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

### Task 13: Browser validation + wiki + handover

**Files:**
- Create: `docs/wiki/voice-studio.md`
- Modify: `docs/wiki/voice-agent.md`
- Modify: `docs/wiki/README.md`
- Create: `docs/handovers/2026-09-15-breeze-tts-voice-stack.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`

**Interfaces:**
- Consumes: everything
- Produces: nothing

- [ ] **Step 1: Prove it in a real browser**

Green typecheck and green unit tests both report silence as success — the PCM path has no
unit-test safety net. Use the project's `browser-testing` skill (`playwright-cli`, **not** the MCP
browser tools — see CLAUDE.md) and confirm each of:

1. `/voice` loads (no redirect to `/agent`) and lists the eight seeded presets.
2. Selecting a preset and pressing Speak produces audio: assert `ttfaMs` renders a number under
   200, and that the network response to `/api/voice/speak` carried a non-zero body and an
   `x-sample-rate` header.
3. Creating a design preset persists it — reload and it is still in the rail.
4. The cfg slider is disabled above 1.0 while the instruction is empty.
5. `/agent` speaks with a Breeze preset: enable voice replies, send a typed turn, and assert
   binary frames arrive on the socket and `state` reaches `speaking`.
6. Barge-in still cuts playback mid-reply.

Record the evidence (screenshots + the assertions that passed) — the handover cites it.

- [ ] **Step 2: Write the studio wiki page**

Create `docs/wiki/voice-studio.md` with frontmatter matching the house style
(`title`, `status: shipped`, `cycle: 61`, `updated: 2026-09-15`): what the page does, the four
modes and how each is composed, the preset schema, calibration, the queue priorities, and the
reference-length limits.

- [ ] **Step 3: Rewrite the stale sections of `voice-agent.md`**

The provider table, the "TTS provider status (2026-08-28)" section, the bake-off numbers, the
frame contract (binary = one WAV per sentence), and the env block all describe a stack that no
longer exists. Replace them with the Breeze reality and bump the frontmatter `cycle`/`updated`.
Add `voice-studio.md` to `docs/wiki/README.md`.

- [ ] **Step 4: Write the handover**

Create `docs/handovers/2026-09-15-breeze-tts-voice-stack.md` with accurate frontmatter (see any
recent handover for the shape). It must state plainly: what shipped, the browser evidence from
Step 1, that multi-speaker was deferred (task `9b26ae79-7080-4814-9af0-74b3eedf2574`), and that
bilingual is out of scope by decision rather than by omission.

- [ ] **Step 5: Add the roadmap row**

Append cycle 61 to the table in `docs/superpowers/plans/00-roadmap.md`, following the format of
row 60, linking the spec, this plan, and the handover.

- [ ] **Step 6: Mirror the docs to MyMind**

Per CLAUDE.md, wiki and handover docs are mirrored. Use `mcp__mymind__save_document` with
`project: 'mymind'` for `voice-studio.md` and the handover.

- [ ] **Step 7: Mark the task complete**

Update MyMind task `5e4a7c6f-01fb-4596-9e61-06692d4f5772` to `completed`.

- [ ] **Step 8: Final gates + commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

```bash
git add -A
git commit -m "docs(voice): cycle 61 wiki, handover and roadmap

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VeEobExZCrKbMNg2cmyx1G"
```

---

## Self-Review Notes

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Measured facts → pre-flight rules | 2 |
| Streaming PCM, truncation detection, header sample rate | 3 |
| Priority queue, 409 | 4, 5 |
| Buffering removal | 5, 8 |
| `voice_presets` + seed + derived mode | 1, 6 |
| Calibration + reference limits | 7, 10 |
| Deleting the failover chain | 8 |
| WS contract (`audio-begin`/`audio-end`) | 8, 9 |
| Client PCM path, cookie migration | 9 |
| `/voice` page, all four modes, events, read-aloud | 10, 11 |
| Error handling table | 2, 3, 4, 10 |
| Sanitizer regression test | 12 |
| Migration/cleanup list | 12 |
| Testing (unit + browser) | every task, 13 |

**Known deviation from the spec:** the spec says the studio shares the queue "at lower priority",
which Task 5 implements as `'studio'`; the spec's calibration probe also runs at studio priority
(Task 7 `makeLiveProbe`), so saving a clone preset can wait behind a live conversation. That is
intended.

**Not covered here, by decision:** multi-speaker dialogue (deferred), bilingual EN/ZH (out of
scope).
