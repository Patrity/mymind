# Image Editing (img2img) — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `edit_image` agent tool (ComfyUI img2img on the current Qwen-Image model) and make generated/edited images render reliably in the agent chat by having the **server** author the image embed from the real row — the model never receives a URL to hallucinate.

**Architecture:** Extend the cycle-36 `server/lib/imagegen/` module with an img2img graph builder + a ComfyUI source-upload + `editImage` client. Add `resolveSourceImageId`/`getImageBytes` + a tags-parametrized persist in the images service. Add a `display` channel to the agent tool result that carries the real image url to the UI (not the model); the orchestrator strips any model-authored `/api/images` embeds and appends the server-authored `![alt](url)` to the assistant turn (live + persisted). Add the `edit_image` tool and change `generate_image` to use the same model-no-url + server-embed path.

**Tech Stack:** Nuxt 4 / Nitro (server), Drizzle (Postgres `images`/`settings`), Vitest, `$fetch` (ofetch, incl. multipart via `FormData`), Nuxt UI v4.

## Global Constraints

- **img2img on the CURRENT model — no new rig install.** Stock ComfyUI nodes (`LoadImage`→`VAEEncode`→`KSampler` at `denoise`<1) + the `POST /upload/image` endpoint. Source image filenames come from uploading the MyMind image bytes to ComfyUI.
- **The model NEVER receives an image URL.** `generate_image`/`edit_image` return to the model only `{ ok:true, image_id }` (+ summary). The URL travels on a separate `display` channel to the UI; the **server** authors the chat embed. This supersedes cycle-36's model-pastes-markdown approach.
- **Tools NEVER throw on an expected backend failure** — return `{ ok:false, error }` (the `web_fetch`/`generateImage` convention). Wrap the persist (`createGeneratedImage` can throw).
- **`edit_image` is `kind:'create'`, NOT `dangerous`** — rides the default toolset + MCP (auto-exposed; surface goes 19 → 20 tools).
- **Every successful create calls `publishChange({ resource:'image', action:'created', id })`** after commit.
- **Embeddings 2560-dim** (`halfvec`), written `embedding: vec as unknown` (existing idiom). **No DB migration** — every column already exists.
- **Package manager: `pnpm`.** Gates: **typecheck + test + build**. Lint is red repo-wide and is NOT a gate — ignore it.
- App code: repo-root `app/`; server: repo-root `server/` (NOT `apps/web/`).

### Reference files to mirror (open these)
| To build | Mirror |
|---|---|
| `buildImg2ImgGraph` | `server/lib/imagegen/graph.ts` `buildComfyGraph` (9-node template) |
| `uploadSourceImage` / `editImage` | `server/lib/imagegen/comfy.ts` `generateImage` (bare `$fetch`, never-throws, poll loop, `extractOutputImage`) |
| `editStrength` config | `server/lib/imagegen/store.ts` (defaults + `imageConfigInputSchema`) |
| `resolveSourceImageId` / persist | `server/services/images.ts` `getImage`, `createGeneratedImage`/`buildGeneratedImageValues`, `serveUrl`, `deleteImage`, the `searchImages` `arrayOverlaps`/`sql` tag idioms |
| `display` + embed injection | `server/lib/agent/types.ts` (`ToolExecution`), `ai-tools.ts` (onEvent), `run.ts` (`AgentEvent`), `voice/orchestrator.ts` (`handleTurn` assembles `assistantText`) |
| `edit_image` tool | `server/lib/agent/tools.ts` `generate_image` block (kind `create`, undo, never-throws) |

### Facts verified 2026-06-25 (trust these)
- `ToolExecution = { result: unknown; summary: string; undo?: () => Promise<void> }` (`types.ts`). The handler return is forwarded: `ai-tools.ts:57` returns `exec.result` to the model; `ai-tools.ts:55-56` emits `{ type:'tool-result', name, summary, undoToken }` to the UI.
- `runAgent` yields `AgentEvent` (`run.ts`): `text-delta` / `tool-start` / `tool-result {name,summary,undoToken}` / `done`.
- `handleTurn` (`orchestrator.ts`) concatenates `text-delta`s into `assistantText`, emits `{type:'tool',...}` (the chip) on `tool-result`, and returns `[...messages, {role:'assistant', content: assistantText}]`. The WS (`ws.ts`) persists that content via `appendMessages` and forwards every non-audio `VoiceEvent` as JSON (incl. `transcript`).
- `Transcript.vue` renders assistant messages via `<MdView>` (MDC) → `![](url)` becomes a plain `<img>` that loads `/api/images/<id>/raw` with the session cookie. No `@nuxt/image`/`ProseImg` override.
- `images` columns exist: `summary`, `embedding halfvec(2560)`, `enrich_status`, `tags text[]`, `make_document`, `is_public`, `storage_key`, `mime`, `ext`, `kind`, `width`, `height`, `size`. `createGeneratedImage` hardcodes `tags:['generated']` today.
- `serveUrl(row)` → `/api/images/<id>/raw` (private) ; `getImage(id)` → live row | null ; `storage().get(key)` → `{ stream }` ; `deleteImage(id)` soft-deletes.
- `chat.post.ts` calls `runAgent` directly (headless SSE) — NOT the orchestrator. The visual embed injection is the orchestrator (WS) path; the model-no-url change is global and benefits both.
- Tool count is 19 (`mcp-parity.test.ts` + `agent-tools.test.ts` assert it). Adding `edit_image` → 20; both tests must be updated.

---

### Task 1: img2img graph builder (pure) + EditParams type

**Files:**
- Modify: `server/lib/imagegen/types.ts`
- Modify: `server/lib/imagegen/graph.ts`
- Test: `server/lib/imagegen/img2img-graph.test.ts`

**Interfaces:**
- Produces: `EditParams`, `buildImg2ImgGraph(params: EditParams, config: ImageGenConfig, sourceFilename: string): ComfyGraph`.

- [ ] **Step 1: Add the type** — in `server/lib/imagegen/types.ts`, after `GenerateParams`:

```ts
/** Tool inputs for an img2img edit, after Zod parsing. `seed` resolved by the caller. */
export interface EditParams {
  prompt: string
  negativePrompt?: string
  steps?: number
  cfg?: number
  seed: number
  strength?: number   // KSampler denoise (0..1); lower = closer to source
}
```

Also extend `ImageGenConfig` (same file) by adding one field after `scheduler`:

```ts
  editStrength: number   // default img2img denoise when the tool omits strength
```

- [ ] **Step 2: Write the failing test** — create `server/lib/imagegen/img2img-graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildImg2ImgGraph } from './graph'
import type { ImageGenConfig, EditParams } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'qwen_image_fp8_e4m3fn.safetensors',
  clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple', editStrength: 0.55
}

describe('buildImg2ImgGraph', () => {
  it('wires the source image through LoadImage -> VAEEncode -> KSampler.latent_image', () => {
    const params: EditParams = { prompt: 'make the hat blue', negativePrompt: 'blurry', seed: 42, steps: 8, cfg: 3, strength: 0.6 }
    const g = buildImg2ImgGraph(params, config, 'src.png')
    expect(g['10'].class_type).toBe('LoadImage')
    expect(g['10'].inputs.image).toBe('src.png')
    expect(g['11'].class_type).toBe('VAEEncode')
    expect(g['11'].inputs.pixels).toEqual(['10', 0])
    expect(g['11'].inputs.vae).toEqual(['3', 0])
    expect(g['7'].inputs.latent_image).toEqual(['11', 0])
    expect(g['7'].inputs.denoise).toBe(0.6)
    expect(g['7'].inputs.seed).toBe(42)
    expect(g['7'].inputs.steps).toBe(8)
    expect(g['4'].inputs.text).toBe('make the hat blue')
    expect(g['5'].inputs.text).toBe('blurry')
    expect(g['8'].inputs.samples).toEqual(['7', 0])
    expect(g['9'].class_type).toBe('SaveImage')
  })

  it('defaults strength to config.editStrength and applies steps/cfg defaults', () => {
    const g = buildImg2ImgGraph({ prompt: 'x', seed: 1 }, config, 'a.png')
    expect(g['7'].inputs.denoise).toBe(0.55)
    expect(g['7'].inputs.steps).toBe(20)
    expect(g['7'].inputs.cfg).toBe(2.5)
    expect(g['5'].inputs.text).toBe('')
  })
})
```

- [ ] **Step 3: Run test to verify it fails** — `pnpm vitest run server/lib/imagegen/img2img-graph.test.ts` → FAIL ("buildImg2ImgGraph is not a function").

- [ ] **Step 4: Implement** — in `server/lib/imagegen/graph.ts`, add the import of `EditParams` to the existing type import and append:

```ts
/**
 * img2img: same loaders/encoders as the text-to-image graph, but the latent comes
 * from encoding the uploaded source image (LoadImage -> VAEEncode) and KSampler runs
 * at denoise<1 (strength). The caller resolves `seed`; this stays pure.
 */
export function buildImg2ImgGraph(params: EditParams, config: ImageGenConfig, sourceFilename: string): ComfyGraph {
  const steps = params.steps ?? config.steps
  const cfg = params.cfg ?? config.cfg
  const denoise = params.strength ?? config.editStrength
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: config.unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: config.clipName, type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: config.vaeName } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt ?? '', clip: ['2', 0] } },
    '10': { class_type: 'LoadImage', inputs: { image: sourceFilename } },
    '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['3', 0] } },
    '7': { class_type: 'KSampler', inputs: {
      seed: params.seed, steps, cfg, sampler_name: config.sampler, scheduler: config.scheduler, denoise,
      model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['11', 0]
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mymind-edit', images: ['8', 0] } }
  }
}
```

> Note: adding `editStrength` to `ImageGenConfig` will make existing `ImageGenConfig` literals in OTHER test files fail typecheck until Task 2 adds it to `defaultImageConfig()`. That's expected; Task 2 closes it. The img2img test above already includes `editStrength` in its literal.

- [ ] **Step 5: Run test to verify it passes** — `pnpm vitest run server/lib/imagegen/img2img-graph.test.ts` → PASS (2).

- [ ] **Step 6: Commit**

```bash
git add server/lib/imagegen/types.ts server/lib/imagegen/graph.ts server/lib/imagegen/img2img-graph.test.ts
git commit -m "feat(imagegen): img2img graph builder + EditParams"
```

---

### Task 2: `editStrength` config default + validation

**Files:**
- Modify: `server/lib/imagegen/store.ts`
- Test: `server/lib/imagegen/store.test.ts` (extend)

**Interfaces:**
- Consumes/Produces: `defaultImageConfig()` now returns `editStrength`; `imageConfigInputSchema` accepts it.

- [ ] **Step 1: Add the failing test** — append to `server/lib/imagegen/store.test.ts`:

```ts
describe('editStrength', () => {
  it('defaults to 0.55 and is validated in range', async () => {
    const { defaultImageConfig, parseImageConfigInput } = await import('./store')
    expect(defaultImageConfig().editStrength).toBe(0.55)
    expect(parseImageConfigInput({ editStrength: 0.7 }).editStrength).toBe(0.7)
    expect(() => parseImageConfigInput({ editStrength: 2 })).toThrow()
  })
})
```

- [ ] **Step 2: Run it** — `pnpm vitest run server/lib/imagegen/store.test.ts` → the new case FAILS (`editStrength` undefined / not validated).

- [ ] **Step 3: Implement** — in `server/lib/imagegen/store.ts`:
  - In `defaultImageConfig()` return object, add `editStrength: 0.55` (after `scheduler`).
  - In `imageConfigInputSchema`, add: `editStrength: z.number().min(0).max(1).optional(),`

- [ ] **Step 4: Run it** — `pnpm vitest run server/lib/imagegen/store.test.ts` → PASS. Then `pnpm typecheck` → 0 errors (this closes the `ImageGenConfig` literal gap from Task 1; if any other test literal still lacks `editStrength`, add it there).

- [ ] **Step 5: Commit**

```bash
git add server/lib/imagegen/store.ts server/lib/imagegen/store.test.ts
git commit -m "feat(imagegen): editStrength config default + validation"
```

---

### Task 3: ComfyUI source upload + `editImage` client (never-throws)

**Files:**
- Modify: `server/lib/imagegen/comfy.ts`
- Test: `server/lib/imagegen/edit.test.ts`

**Interfaces:**
- Consumes: `buildImg2ImgGraph` (Task 1), `loadImageConfig`, `extractOutputImage` (existing in comfy.ts).
- Produces:
  - `uploadSourceImage(bytes: Buffer, filename: string, opts: { config: ImageGenConfig; signal?: AbortSignal }): Promise<{ ok: true; name: string } | { ok: false; error: string }>`
  - `editImage(params: { prompt: string; negativePrompt?: string; steps?: number; cfg?: number; seed?: number; strength?: number; sourceBytes: Buffer; sourceMime: string }, opts?: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number }): Promise<GenerateResult>` — never throws.

- [ ] **Step 1: Write the failing test** — create `server/lib/imagegen/edit.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { editImage } from './comfy'
import type { ImageGenConfig } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188', unetName: 'u', clipName: 'c', vaeName: 'v',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple', editStrength: 0.55
}
const src = { sourceBytes: Buffer.from([9, 9, 9]), sourceMime: 'image/webp' }

afterEach(() => { vi.unstubAllGlobals() })

describe('editImage', () => {
  it('uploads the source, submits img2img, polls, fetches bytes, returns ok', async () => {
    const png = new Uint8Array([1, 2, 3]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ name: 'src.png', subfolder: '', type: 'input' })                               // POST /upload/image
      .mockResolvedValueOnce({ prompt_id: 'p1' })                                                             // POST /prompt
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } }) // /history
      .mockResolvedValueOnce(png)                                                                             // GET /view
    vi.stubGlobal('$fetch', $fetch)
    const res = await editImage({ ...src, prompt: 'make it blue', seed: 5 }, { config, clientId: 'cid', pollIntervalMs: 1, maxWaitMs: 1000 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.buffer.length).toBe(3)
    expect(String($fetch.mock.calls[0][0])).toContain('/upload/image')   // upload first
    expect(String($fetch.mock.calls[1][0])).toContain('/prompt')
  })

  it('returns { ok:false } (no throw) when the upload fails', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const res = await editImage({ ...src, prompt: 'x', seed: 1 }, { config, pollIntervalMs: 1, maxWaitMs: 50 })
    expect(res).toEqual({ ok: false, error: expect.stringContaining('ECONNREFUSED') })
  })

  it('returns { ok:false } when no baseURL is configured', async () => {
    const res = await editImage({ ...src, prompt: 'x', seed: 1 }, { config: { ...config, baseURL: null } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not configured/i)
  })
})
```

- [ ] **Step 2: Run it** — `pnpm vitest run server/lib/imagegen/edit.test.ts` → FAIL ("editImage is not a function").

- [ ] **Step 3: Implement** — in `server/lib/imagegen/comfy.ts` add the import of `buildImg2ImgGraph` to the existing `./graph` import, then append (reuses the file's `extractOutputImage`, `mimeFromName`, `sleep`, `randomSeed`):

```ts
/** Upload a source image to ComfyUI's input store; returns the referenceable filename. Never throws. */
export async function uploadSourceImage(
  bytes: Buffer, filename: string, opts: { config: ImageGenConfig; signal?: AbortSignal }
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const base = opts.config.baseURL?.replace(/\/$/, '')
  if (!base) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings -> Image Gen)' }
  try {
    const fd = new FormData()
    fd.append('image', new Blob([bytes]), filename)
    fd.append('overwrite', 'true')
    const r = await $fetch<{ name?: string; subfolder?: string }>(`${base}/upload/image`, { method: 'POST', body: fd, signal: opts.signal })
    if (!r?.name) return { ok: false, error: 'ComfyUI upload returned no filename' }
    return { ok: true, name: r.subfolder ? `${r.subfolder}/${r.name}` : r.name }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function editImage(
  params: { prompt: string; negativePrompt?: string; steps?: number; cfg?: number; seed?: number; strength?: number; sourceBytes: Buffer; sourceMime: string },
  opts: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number } = {}
): Promise<GenerateResult> {
  try {
    const config = opts.config ?? await loadImageConfig()
    if (!config.baseURL) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings -> Image Gen)' }
    const base = config.baseURL.replace(/\/$/, '')
    const seed = params.seed ?? randomSeed()
    const steps = params.steps ?? config.steps
    const cfg = params.cfg ?? config.cfg
    const clientId = opts.clientId ?? `mymind-edit-${seed}-${Date.now()}`
    const pollIntervalMs = opts.pollIntervalMs ?? 1500
    const maxWaitMs = opts.maxWaitMs ?? 180_000
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }

    const ext = MIME_BY_EXT_REVERSE(params.sourceMime)
    const up = await uploadSourceImage(params.sourceBytes, `mymind-src-${seed}.${ext}`, { config, signal: opts.signal })
    if (!up.ok) return up

    const graph = buildImg2ImgGraph({ prompt: params.prompt, negativePrompt: params.negativePrompt, steps: params.steps, cfg: params.cfg, seed, strength: params.strength }, config, up.name)
    const submit = await $fetch<{ prompt_id?: string }>(`${base}/prompt`, { method: 'POST', body: { prompt: graph, client_id: clientId }, signal: opts.signal })
    const promptId = submit?.prompt_id
    if (!promptId) return { ok: false, error: 'ComfyUI did not return a prompt_id' }

    const start = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
      if (Date.now() - start > maxWaitMs) return { ok: false, error: `image edit timed out after ${Math.round(maxWaitMs / 1000)}s` }
      const history = await $fetch(`${base}/history/${promptId}`, { signal: opts.signal })
      const out = extractOutputImage(history, promptId)
      if (out) {
        const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type })
        const ab = await $fetch<ArrayBuffer>(`${base}/view?${q.toString()}`, { responseType: 'arrayBuffer', signal: opts.signal })
        return { ok: true, buffer: Buffer.from(ab), mime: mimeFromName(out.filename), meta: { seed, width: config.width, height: config.height, steps, cfg } }
      }
      await sleep(pollIntervalMs)
    }
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// reverse of MIME_BY_EXT for naming the upload (webp/png/jpg); defaults to 'png'.
function MIME_BY_EXT_REVERSE(mime: string): string {
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/jpeg') return 'jpg'
  return 'png'
}
```

> If `MIME_BY_EXT` / `mimeFromName` / `sleep` / `randomSeed` are not exported, they are in the same module already (cycle 36) — call them directly (same file). Confirm the names match `comfy.ts` and reuse; do not re-declare `sleep`/`randomSeed`/`mimeFromName`/`extractOutputImage` (they exist).

- [ ] **Step 4: Run it** — `pnpm vitest run server/lib/imagegen/edit.test.ts` → PASS (3). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add server/lib/imagegen/comfy.ts server/lib/imagegen/edit.test.ts
git commit -m "feat(imagegen): ComfyUI source upload + editImage client (never-throws)"
```

---

### Task 4: images service — source resolution, bytes, tags-parametrized persist

**Files:**
- Modify: `server/services/images.ts`
- Test: `test/images-edit.test.ts`

**Interfaces:**
- Produces:
  - `resolveSourceImageId(explicitId: string | null): Promise<string | null>` — explicit (verified live) or newest live `generated` image; null if none.
  - `getImageBytes(id: string): Promise<{ bytes: Buffer; mime: string } | null>`.
  - `createGeneratedImage(buffer, mime, opts: { prompt: string; tags?: string[] })` — `tags` defaults to `['generated']`.
  - `buildGeneratedImageValues(args)` gains `tags: string[]`.

- [ ] **Step 1: Write the failing test** — create `test/images-edit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildGeneratedImageValues } from '../server/services/images'

describe('buildGeneratedImageValues tags', () => {
  const base = { storageKey: 'k', mime: 'image/webp', ext: 'webp', kind: 'image', width: 1024, height: 1024, size: 9 }
  it('uses the provided tags (e.g. generated+edited)', () => {
    const v = buildGeneratedImageValues({ ...base, prompt: 'make it blue', embedding: null, tags: ['generated', 'edited'] })
    expect(v.tags).toEqual(['generated', 'edited'])
    expect(v.summary).toBe('make it blue')
    expect(v.enrichStatus).toBe('done')
  })
})
```

- [ ] **Step 2: Run it** — `pnpm vitest run test/images-edit.test.ts` → FAIL (`tags` arg not accepted / value wrong).

- [ ] **Step 3: Implement** — in `server/services/images.ts`:
  - Add `arrayContains` (or reuse `sql`) to the `drizzle-orm` import if needed (the file already imports `arrayOverlaps`, `desc`, `eq`, `and`, `isNull`, `sql`).
  - Change `buildGeneratedImageValues` signature to add `tags: string[]` and use it: `tags: args.tags` (replace the hardcoded `['generated']`). Add `tags: string[]` to its args type.
  - Change `createGeneratedImage(buffer, mime, opts: { prompt: string; tags?: string[] })`; pass `tags: opts.tags ?? ['generated']` into `buildGeneratedImageValues`.
  - Add:

```ts
/** Resolve the source image for an edit: the explicit id (must be live) or the newest generated image. */
export async function resolveSourceImageId(explicitId: string | null): Promise<string | null> {
  if (explicitId) {
    const row = await getImage(explicitId)
    return row ? row.id : null
  }
  const [row] = await useDb().select({ id: images.id }).from(images)
    .where(and(live(), sql`${'generated'} = ANY(${images.tags})`))
    .orderBy(desc(images.createdAt)).limit(1)
  return row?.id ?? null
}

/** Read a stored image's bytes (for feeding an edit to ComfyUI). */
export async function getImageBytes(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const row = await getImage(id)
  if (!row) return null
  const { stream } = await storage().get(row.storageKey)
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
  return { bytes: Buffer.concat(chunks), mime: row.mime }
}
```

> `live()` is the existing `isNull(images.deletedAt)` helper in this file. If the `sql\`... = ANY ...\`` form complains, mirror the existing tag predicate in `searchImages` (`sql\`${images.tags} && ARRAY[${'generated'}]::text[]\``).

- [ ] **Step 4: Run it** — `pnpm vitest run test/images-edit.test.ts` → PASS. `pnpm typecheck` → 0. Also re-run `pnpm vitest run test/images-generated.test.ts` (the cycle-36 persist test) → still PASS (tags now sourced from args; default unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/services/images.ts test/images-edit.test.ts
git commit -m "feat(images): resolveSourceImageId + getImageBytes + tags-parametrized persist"
```

---

### Task 5: Reliable render — `display` channel + server-authored embeds

**Files:**
- Modify: `server/lib/agent/types.ts`, `server/lib/agent/run.ts`, `server/lib/agent/ai-tools.ts`, `server/lib/voice/orchestrator.ts`
- Create: `server/lib/agent/image-embed.ts`
- Test: `server/lib/agent/image-embed.test.ts`, `server/lib/voice/orchestrator-embed.test.ts`

**Interfaces:**
- Produces:
  - `ToolExecution.display?: { images: DisplayImage[] }` where `DisplayImage = { id: string; url: string; alt: string }`.
  - `AgentEvent`/`LoopEvent` `tool-result` gains `images?: DisplayImage[]`; `VoiceEvent` `tool` gains `images?: DisplayImage[]`.
  - `applyImageEmbeds(text: string, images: DisplayImage[]): { content: string; appended: string }` (pure) — strips model-authored `/api/images/...` embeds/links, appends `![alt](url)` for each image; `appended` is the suffix to stream live.

- [ ] **Step 1: Write the failing pure test** — create `server/lib/agent/image-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyImageEmbeds } from './image-embed'

const img = (id: string) => ({ id, url: `/api/images/${id}/raw`, alt: 'a cat' })

describe('applyImageEmbeds', () => {
  it('appends a server embed and strips any model-authored /api/images embed', () => {
    const text = 'Here you go: ![hallucinated](/api/images/HALLUCINATED/raw)'
    const { content, appended } = applyImageEmbeds(text, [img('real1')])
    expect(content).not.toContain('HALLUCINATED')
    expect(content).toContain('![a cat](/api/images/real1/raw)')
    expect(appended).toContain('![a cat](/api/images/real1/raw)')
  })

  it('also strips a model-authored markdown LINK to /api/images', () => {
    const { content } = applyImageEmbeds('see [here](/api/images/x/raw)', [img('real1')])
    expect(content).not.toContain('/api/images/x/raw')
    expect(content).toContain('/api/images/real1/raw')
  })

  it('no images -> returns text unchanged, empty appended', () => {
    expect(applyImageEmbeds('hello', [])).toEqual({ content: 'hello', appended: '' })
  })
})
```

- [ ] **Step 2: Run it** — `pnpm vitest run server/lib/agent/image-embed.test.ts` → FAIL.

- [ ] **Step 3: Implement the helper** — create `server/lib/agent/image-embed.ts`:

```ts
// server/lib/agent/image-embed.ts
// The SERVER owns image embeds in the chat. The model never receives a URL, so it
// cannot show an image that wasn't generated. This strips any /api/images embed the
// model wrote anyway (belt-and-suspenders) and appends the real embed(s).
export interface DisplayImage { id: string; url: string; alt: string }

// matches ![alt](/api/images/...) and [text](/api/images/.../raw) the model might author
const MODEL_IMG_RE = /!?\[[^\]]*\]\((?:https?:\/\/[^)]*)?\/api\/images\/[^)]*\)/g

export function applyImageEmbeds(text: string, images: DisplayImage[]): { content: string; appended: string } {
  const stripped = (text ?? '').replace(MODEL_IMG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!images.length) return { content: stripped, appended: '' }
  const sanitize = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 120)
  const embeds = images.map(i => `![${sanitize(i.alt)}](${i.url})`).join('\n\n')
  const appended = (stripped ? '\n\n' : '') + embeds
  return { content: stripped + appended, appended }
}
```

- [ ] **Step 4: Run it** — `pnpm vitest run server/lib/agent/image-embed.test.ts` → PASS (3).

- [ ] **Step 5: Thread the `display` type through the pipeline**
  - `server/lib/agent/types.ts`:
    - Add `import type { DisplayImage } from './image-embed'` is circular — instead define `DisplayImage` in `image-embed.ts` (done) and import it in `types.ts`: add `import type { DisplayImage } from './image-embed'` (one-way; image-embed has no agent-types import). Add `display?: { images: DisplayImage[] }` to `ToolExecution`. Add `images?: DisplayImage[]` to the `LoopEvent` `tool-result` variant.
  - `server/lib/agent/run.ts`: add `images?: import('./image-embed').DisplayImage[]` to the `AgentEvent` `tool-result` variant.
  - `server/lib/agent/ai-tools.ts`: in the success path, change the emit to `hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken, images: exec.display?.images })`. Update the `RunHooks.onEvent` union's `tool-result` to include `images?`.

- [ ] **Step 6: Wire the orchestrator** — `server/lib/voice/orchestrator.ts`:
  - Add `images?: import('../agent/image-embed').DisplayImage[]` to the `VoiceEvent` `tool` variant.
  - Import: `import { applyImageEmbeds, type DisplayImage } from '../agent/image-embed'`.
  - In `handleTurn`, before the loop: `const turnImages: DisplayImage[] = []`.
  - In the `tool-result` branch, also collect: `if (ev.images?.length) turnImages.push(...ev.images)` and pass `images: ev.images` on the emitted `tool` event.
  - After the loop, replace the final `return assistantText ? ... : messages` with:

```ts
  if (turnImages.length) {
    const { content, appended } = applyImageEmbeds(assistantText, turnImages)
    if (appended) deps.emit({ type: 'transcript', role: 'assistant', text: appended })  // live render
    assistantText = content
  }
  return assistantText ? [...messages, { role: 'assistant', content: assistantText }] : messages
```

- [ ] **Step 7: Write the orchestrator test** — create `server/lib/voice/orchestrator-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'

const tts = { synthesize: async function* () {} }

async function* fakeRun(): AsyncGenerator<AgentEvent> {
  yield { type: 'text-delta', text: 'Done.' }
  yield { type: 'tool-result', name: 'generate_image', summary: 'generated image (real1)', images: [{ id: 'real1', url: '/api/images/real1/raw', alt: 'a cat' }] }
}

describe('handleTurn server-authored image embed', () => {
  it('appends the real embed to the assistant message and emits it live', async () => {
    const events: { type: string; text?: string }[] = []
    const ac = new AbortController()
    const out = await handleTurn('draw a cat', [], {
      tts: tts as never, voice: '', signal: ac.signal, speak: false,
      emit: (e) => events.push(e as { type: string; text?: string }),
      runAgent: fakeRun as never
    })
    const assistant = out[out.length - 1]!
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toContain('![a cat](/api/images/real1/raw)')
    // streamed live as a transcript event too
    expect(events.some(e => e.type === 'transcript' && (e.text ?? '').includes('/api/images/real1/raw'))).toBe(true)
  })
})
```

- [ ] **Step 8: Run + typecheck** — `pnpm vitest run server/lib/agent/image-embed.test.ts server/lib/voice/orchestrator-embed.test.ts` → PASS. `pnpm typecheck` → 0.

- [ ] **Step 9: Commit**

```bash
git add server/lib/agent/types.ts server/lib/agent/run.ts server/lib/agent/ai-tools.ts server/lib/agent/image-embed.ts server/lib/agent/image-embed.test.ts server/lib/voice/orchestrator.ts server/lib/voice/orchestrator-embed.test.ts
git commit -m "feat(agent): server-authored image embeds (display channel) — model never gets a URL"
```

---

### Task 6: `edit_image` tool + `generate_image` switched to display channel

**Files:**
- Modify: `server/lib/agent/tools.ts`
- Test: `test/generate-image-tool.test.ts` (update), `test/edit-image-tool.test.ts` (new), `test/agent-tools.test.ts` (count 19→20)

**Interfaces:**
- Consumes: `editImage` (Task 3), `resolveSourceImageId`/`getImageBytes`/`createGeneratedImage`/`serveUrl`/`deleteImage` (Task 4 / existing), `generateImage` (cycle 36).

- [ ] **Step 1: Update the generate_image tests for the no-URL-to-model + display contract** — in `test/generate-image-tool.test.ts`:
  - In the happy-path test, REPLACE the url/markdown assertions with: the model `result` has NO `url`/`markdown`, carries `image_id`; and `exec.display.images[0]` is `{ id:'img1', url:'/api/images/img1/raw', alt: expect.any(String) }`:

```ts
    const result = exec.result as { ok: boolean; image_id?: string; image_ids?: string[] }
    expect((exec.result as Record<string, unknown>).url).toBeUndefined()
    expect((exec.result as Record<string, unknown>).markdown).toBeUndefined()
    expect(result.image_id ?? result.image_ids?.[0]).toBe('img1')
    const exec2 = exec as { display?: { images: { id: string; url: string }[] } }
    expect(exec2.display!.images[0].url).toBe('/api/images/img1/raw')
```
  - DELETE the two markdown-embed tests added by the cycle-36 post-ship fix ("returns embeddable markdown…" and "sanitizes square brackets…") — that behavior moves server-side (covered by `image-embed.test.ts`). Keep the partial-success/abort/persist-throw/seed-stride tests; update any that read `result.images[].url` to read `exec.display.images[].url` instead.

- [ ] **Step 2: Write the edit_image test** — create `test/edit-image-tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/lib/imagegen/comfy', () => ({ editImage: vi.fn(), generateImage: vi.fn() }))
vi.mock('../server/services/images', () => ({
  resolveSourceImageId: vi.fn(),
  getImageBytes: vi.fn(),
  createGeneratedImage: vi.fn(),
  deleteImage: vi.fn(),
  serveUrl: (row: { id: string }) => `/api/images/${row.id}/raw`
}))
vi.mock('../server/utils/live-bus', () => ({ publishChange: vi.fn() }))

import { agentTools } from '../server/lib/agent/tools'
import { editImage } from '../server/lib/imagegen/comfy'
import { resolveSourceImageId, getImageBytes, createGeneratedImage, deleteImage } from '../server/services/images'
import { publishChange } from '../server/utils/live-bus'

const tool = agentTools.find(t => t.name === 'edit_image')!
const ctx = { signal: new AbortController().signal }
beforeEach(() => { vi.clearAllMocks() })

describe('edit_image tool', () => {
  it('is registered, create-kind, not dangerous', () => {
    expect(tool).toBeTruthy()
    expect(tool.kind).toBe('create')
    expect(tool.dangerous).toBeFalsy()
  })

  it('edits the resolved source, persists generated+edited, returns image_id + display (no url to model)', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue('src1')
    ;(getImageBytes as any).mockResolvedValue({ bytes: Buffer.from([1]), mime: 'image/webp' })
    ;(editImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([2]), mime: 'image/png', meta: { seed: 9, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any).mockResolvedValue({ id: 'edit1', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'make the hat blue' }, ctx)
    expect((exec.result as Record<string, unknown>).url).toBeUndefined()
    expect((exec.result as { image_id: string }).image_id).toBe('edit1')
    expect((exec as { display: { images: { url: string }[] } }).display.images[0].url).toBe('/api/images/edit1/raw')
    expect(resolveSourceImageId).toHaveBeenCalledWith(null)
    expect(createGeneratedImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', { prompt: 'make the hat blue', tags: ['generated', 'edited'] })
    expect(publishChange).toHaveBeenCalledWith({ resource: 'image', action: 'created', id: 'edit1' })
    await exec.undo!()
    expect(deleteImage).toHaveBeenCalledWith('edit1')
  })

  it('clean error when there is no source image to edit', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue(null)
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(editImage).not.toHaveBeenCalled()
  })

  it('clean error (no throw) when editImage fails', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue('src1')
    ;(getImageBytes as any).mockResolvedValue({ bytes: Buffer.from([1]), mime: 'image/webp' })
    ;(editImage as any).mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(createGeneratedImage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run both → fail** — `pnpm vitest run test/edit-image-tool.test.ts test/generate-image-tool.test.ts` → FAIL (no `edit_image`; generate_image result still has url).

- [ ] **Step 4: Implement** — in `server/lib/agent/tools.ts`:
  - Imports: add `editImage` to the `../imagegen/comfy` import; add `resolveSourceImageId, getImageBytes` to the `../../services/images` import (keep existing `createGeneratedImage, deleteImage, serveUrl`).
  - **generate_image** handler: change `made` to collect display + drop url from the model result. Replace the push + return:

```ts
        publishChange({ resource: 'image', action: 'created', id: row.id })
        made.push({ id: row.id, url: serveUrl(row), seed: gen.meta.seed })
      }
      const alt = params.prompt.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 120)
      return {
        result: made.length === 1
          ? { ok: true, image_id: made[0]!.id }
          : { ok: true, image_ids: made.map(m => m.id) },
        display: { images: made.map(m => ({ id: m.id, url: m.url, alt })) },
        summary: made.length === 1 ? `generated image (${made[0]!.id})` : `generated ${made.length} images`,
        undo: async () => { for (const m of made) { await deleteImage(m.id); publishChange({ resource: 'image', action: 'deleted', id: m.id }) } }
      }
```
  Update the **description** (remove the cycle-36 "embed this markdown" instruction): `'Generate an image from a text prompt using the local Qwen-Image model. Saved to the gallery and searchable by its prompt. ~1 minute per image. The image is shown to the user automatically — do NOT write an image link or markdown in your reply. On failure the result is { ok:false, error } — say so rather than retrying.'`

  - **edit_image** — add this entry right after the generate_image block:

```ts
  {
    name: 'edit_image',
    description: 'Edit/iterate on an existing image (local Qwen-Image img2img): describe the change (e.g. "make the hat blue"). By default edits the most recently generated image; pass source_image_id to edit a specific one. Note: img2img re-rolls the whole image guided by the prompt, so it shifts more than just the named part (strength controls how much). The result is shown to the user automatically — do NOT write an image link. On failure the result is { ok:false, error }.',
    kind: 'create',
    schema: {
      prompt: z.string().min(1).describe('The change to make'),
      source_image_id: z.string().optional().describe('Image to edit (defaults to the most recently generated image)'),
      strength: z.number().min(0).max(1).optional().describe('How far to depart from the source (denoise; default ~0.55)'),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional()
    },
    handler: async (a, ctx) => {
      const sourceId = await resolveSourceImageId((a.source_image_id as string | undefined) ?? null)
      if (!sourceId) return { result: { ok: false, error: 'no image to edit — generate an image first, or pass a valid source_image_id' }, summary: 'edit failed: no source image' }
      const src = await getImageBytes(sourceId)
      if (!src) return { result: { ok: false, error: 'source image not found' }, summary: 'edit failed: source not found' }
      const prompt = a.prompt as string
      const gen = await editImage({
        prompt, negativePrompt: a.negative_prompt as string | undefined,
        strength: a.strength as number | undefined, seed: a.seed as number | undefined,
        sourceBytes: src.bytes, sourceMime: src.mime
      }, { signal: ctx.signal })
      if (!gen.ok) return { result: { ok: false, error: gen.error }, summary: `edit failed: ${gen.error}` }
      let row
      try {
        row = await createGeneratedImage(gen.buffer, gen.mime, { prompt, tags: ['generated', 'edited'] })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { result: { ok: false, error: msg }, summary: `edit failed: ${msg}` }
      }
      publishChange({ resource: 'image', action: 'created', id: row.id })
      const url = serveUrl(row)
      const alt = prompt.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 120)
      return {
        result: { ok: true, image_id: row.id },
        display: { images: [{ id: row.id, url, alt }] },
        summary: `edited image (${row.id})`,
        undo: async () => { await deleteImage(row!.id); publishChange({ resource: 'image', action: 'deleted', id: row!.id }) }
      }
    }
  },
```

- [ ] **Step 5: Update the registry-count test** — `test/agent-tools.test.ts`: bump the expected count 19→20 and add `'edit_image'` to the expected sorted name array.

- [ ] **Step 6: Run tests + typecheck** — `pnpm vitest run test/edit-image-tool.test.ts test/generate-image-tool.test.ts test/agent-tools.test.ts` → PASS. `pnpm typecheck` → 0.

- [ ] **Step 7: Commit**

```bash
git add server/lib/agent/tools.ts test/edit-image-tool.test.ts test/generate-image-tool.test.ts test/agent-tools.test.ts
git commit -m "feat(agent): edit_image tool (img2img) + generate_image via display channel"
```

---

### Task 7: Settings — `editStrength` field in the Image Gen tab

**Files:**
- Modify: `app/composables/useImageConfig.ts`, `app/components/settings/ImageGenTab.vue`

> Verified by typecheck + build + the live pass. Mirror the existing numeric fields in the tab.

- [ ] **Step 1: Composable** — in `app/composables/useImageConfig.ts`, add `editStrength: number` to the `ImageConfig` interface (after `scheduler`).

- [ ] **Step 2: Tab** — in `app/components/settings/ImageGenTab.vue`:
  - Add `editStrength: config.value?.editStrength ?? 0.55` to the `form` reactive.
  - Add a number field in the grid (mirror the `cfg` field): label "Edit strength (img2img denoise)", `v-model.number="form.editStrength"`, `type="number"`, `step="0.05"`, `:min="0"`, `:max="1"`.
  - Ensure `editStrength` is included in the `save({ ... })` payload (it is, if you spread `form`).

- [ ] **Step 3: Typecheck + build** — `pnpm typecheck && pnpm build` → 0 errors; build completes.

- [ ] **Step 4: Commit**

```bash
git add app/composables/useImageConfig.ts app/components/settings/ImageGenTab.vue
git commit -m "feat(settings): editStrength field for img2img edits"
```

---

### Task 8: Final wiring verification + docs

**Files:**
- Modify: `docs/wiki/agent.md`, `docs/wiki/mcp.md`, `docs/superpowers/plans/00-roadmap.md`

- [ ] **Step 1: Full gate** — `pnpm typecheck && pnpm vitest run && pnpm build`. Expected: typecheck 0; all pass (cycle-36 baseline 622 minus the 2 deleted generate_image markdown tests, plus the new img2img/edit/embed/orchestrator tests — report the ACTUAL numbers); build clean. If the count or any test is off, STOP and report.

- [ ] **Step 2: Confirm MCP exposure** — `grep -n "agentTools" server/lib/mcp/server.ts` and confirm `edit_image` (non-dangerous) is auto-registered; `test/mcp-parity.test.ts` should assert 20 now (updated in Task 6). Report.

- [ ] **Step 3: Wiki** — `docs/wiki/agent.md`: add `edit_image` to the tool registry table; in the Image generation section, document (a) img2img editing (source defaults to the most recent generated image; `strength`/denoise; whole-image shift caveat), and (b) the **reliable-render** change: the model no longer receives the image URL — the server authors the chat embed from the real row (supersedes the cycle-36 markdown-paste approach), so a hallucinated image can't render. Bump `updated` to 2026-06-25. `docs/wiki/mcp.md`: add `edit_image` row; bump the count to 20.

- [ ] **Step 4: Roadmap** — add a cycle-37 row to `docs/superpowers/plans/00-roadmap.md` (after cycle 36): img2img editing Phase 1 + reliable render; ✅ shipped; link the spec (`../specs/2026-06-25-image-edit-img2img-design.md`), this plan, and the handover `../../handovers/2026-06-25-image-edit-img2img.md` (the controller writes the handover separately).

- [ ] **Step 5: Commit**

```bash
git add docs/wiki docs/superpowers/plans/00-roadmap.md
git commit -m "docs(imagegen): wiki + roadmap — img2img edit + reliable render (cycle 37)"
```

---

## Live verification (post-merge, against the real rig — acceptance)

Not vitest — run after merge with ComfyUI reachable (LAN), via the `/agent` chat:
1. "Generate a cat in a top hat" → image renders inline (server embed); confirm the assistant message has no model-authored link, and the image is in the gallery.
2. "Make the hat blue" (no id) → `edit_image` edits the most-recent generated image → a new edited image renders inline + appears in the gallery (tagged `generated`+`edited`); the cat is recognizably the same, hat shifted toward blue (img2img).
3. Pass an explicit `source_image_id` → edits that image.
4. Stop ComfyUI → `edit_image` returns a clean error in chat; no crash; no spurious activity-log system error.
5. **Hallucination cannot recur:** the model has no URL; even if it writes a fake link, it is stripped and only the real server embed renders.
6. `/settings → Image Gen`: `editStrength` saves and is honored.

## Self-review notes (spec coverage)

- Spec Part 1 (reliable render: model no URL, server embed, strip stray) → Tasks 5 (helper + plumbing + orchestrator) + 6 (tools drop URL, set display).
- Spec Part 2 (source by id, default last generated) → Task 4 (`resolveSourceImageId`) + 6 (edit_image).
- Spec Part 3 (img2img engine) → Tasks 1 (graph) + 2 (editStrength) + 3 (upload + editImage) + 4 (bytes + tags persist) + 6 (edit_image).
- Spec "never-throws / not dangerous / publishChange / no migration" → Global Constraints + Tasks 3, 6.
- Spec testing → graph/edit/embed/orchestrator/tool unit tests; live acceptance above.
- Spec deferred (Phase 2/3, Qwen-Image-Edit, lineage) → not built.
