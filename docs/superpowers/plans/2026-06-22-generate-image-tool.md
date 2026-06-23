# generate_image Agent Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `generate_image` agent tool that renders images via the homelab ComfyUI + Qwen-Image backend and ingests each result into the MyMind gallery/search.

**Architecture:** A new `server/lib/imagegen/` module (pure graph builder + never-throws ComfyUI HTTP client + a DB-backed `image_config` settings doc), a pre-seeded `createGeneratedImage` in the images service (prompt → summary + embedding, vision enrich skipped), and a non-dangerous `generate_image` entry in the agent tool registry (auto-exposed via MCP). A `/settings → Image Gen` tab edits the config.

**Tech Stack:** Nuxt 4 / Nitro (server), Drizzle (Postgres `settings` + `images` tables), Vitest, `$fetch` (ofetch), Nuxt UI v4, `@tanstack/vue-query` is not needed here (config tab uses `useState`+`$fetch` like the other settings tabs).

## Context for a fresh agent (read first)

You are implementing this with **zero prior conversation context**. Everything you need is here.

- **Read the spec first:** [`docs/superpowers/specs/2026-06-22-generate-image-tool-design.md`](../specs/2026-06-22-generate-image-tool-design.md) — the why + the locked design decisions. This plan is the how.
- **Branch:** work on **`feat/generate-image-tool`** (the spec + this plan are committed there; branched off `master` @ `078e801`). The project builds **subagent-driven** (fresh implementer + two-stage reviewer per task, then a final whole-branch review). If you run multiple agents concurrently, isolate them in a **git worktree** — concurrent sessions in one working dir share `HEAD` (a checkout in one moves all).
- **Package manager: `pnpm` only** (never npm/yarn). Commands:
  - `pnpm vitest run <file>` — one test file (fast inner loop). `pnpm test` — the whole suite (`vitest run`).
  - `pnpm typecheck` (`nuxt typecheck`) · `pnpm build` (`nuxt build`).
  - **No DB migration in this cycle** (every column used already exists). Don't run `db:generate`/`db:migrate`.
- **Gates that matter: typecheck + test + build.** **Lint is red repo-wide and is NOT a gate** — `pnpm lint` failures are pre-existing noise; ignore them.
- **Directory layout (verified):** this repo uses **repo-root `app/` and `server/`** — there is **no `apps/web/`**. The auto-injected `.claude/rules/web-nuxt.md` mentions `apps/web/app/`; **ignore that prefix here** and use the repo-root paths in this plan exactly as written.
- **Live-data convention:** every successful write calls `publishChange({ resource, action, id })` after commit (`server/utils/live-bus.ts`); `'image'` is already a valid `ResourceName` (`shared/types/live.ts`). See `.claude/rules/live-data.md`.
- **When writing the `.vue` tab (Task 7):** the `nuxt-ui-docs` / `nuxt-docs` skills carry component/composable APIs — consult them rather than guessing props.

### Reference files to mirror (precedents — open these, copy the idiom)
| To build | Mirror | Why |
|---|---|---|
| `imagegen/store.ts` | `server/lib/search/store.ts` | settings-doc store: module cache + `onConflictDoUpdate` |
| settings get/put/test endpoints | `server/api/settings/search.get.ts`, `search.put.ts`, `test-provider.post.ts` | thin handler shape + `$fetch.raw` connectivity ping |
| `useImageConfig.ts` + Image Gen tab | `app/composables/useExecSecrets.ts` + `app/components/settings/SearchTab.vue` (`SettingsSearchTab`) | `useState`+`$fetch` composable + tab layout/auto-import naming |
| ComfyUI `$fetch` client + its test | `server/lib/ai/embeddings.ts` + `test/embeddings.test.ts` | bare `$fetch` usage + `vi.stubGlobal('$fetch', …)` test idiom |
| `createGeneratedImage` persist | `server/services/images.ts` `createImage` (insert shape, `serveUrl`, `deleteImage`) + `server/services/image-enrich.ts` (the `embedding: vec as any` halfvec write; the cron's `enrichStatus='pending'` predicate → `'done'` rows are skipped) | exact insert/embedding idioms |
| `generate_image` tool | `server/lib/agent/tools.ts` `save_document` (a `create` tool w/ `undo`) + `server/lib/mcp/server.ts` (auto-derives MCP tools from `agentTools` — no MCP wiring needed) | tool registry shape |

### Facts verified 2026-06-22 (trust these — don't re-litigate)
- `settings` columns: `key` (pk text), `value` (jsonb notNull), `updatedAt` (timestamptz) → the store's `onConflictDoUpdate({ target: settings.key, set:{ value, updatedAt } })` is correct.
- `server/services/images.ts` **already imports `embedOne`** (line 8) and exports `serveUrl` + `deleteImage`. `processUpload(buffer, mime, _name?)` — third arg optional.
- `'image'` ∈ `ResourceName`. `pnpm` scripts: `test`=`vitest run`, `typecheck`=`nuxt typecheck`, `build`=`nuxt build`.

## Global Constraints

- **Config lives in the DB, never env** (locked cycle-12 decision). The ComfyUI URL + model filenames + defaults live in a `settings` row `key='image_config'`.
- **Embeddings are 2560-dim** (`images.embedding` is `halfvec(2560)`); written as `embedding: vec as any` (the repo's halfvec write idiom).
- **No migration** — every column used already exists on `images` (`summary`, `embedding`, `enrichStatus`, `tags`).
- **The tool and the ComfyUI client NEVER throw on an expected backend failure** — return `{ ok:false, error }` (the `web_fetch`/`fetchAsMarkdown` convention) so the activity log doesn't record a spurious system error.
- **The tool is NOT `dangerous`** (LAN-internal, non-destructive, single-user) — it rides the default toolset and is auto-exposed via MCP (`server/lib/mcp/server.ts` filters out `dangerous`).
- **Every successful write calls `publishChange({ resource:'image', action:'created', id })`** after the DB commit (live-data convention, `server/utils/live-bus.ts`).
- App code lives under repo-root `app/`; server code under repo-root `server/` (verified — not `apps/web/`).

---

### Task 1: Types + pure ComfyUI graph builder

**Files:**
- Create: `server/lib/imagegen/types.ts`
- Create: `server/lib/imagegen/graph.ts`
- Test: `server/lib/imagegen/graph.test.ts`

**Interfaces:**
- Produces: `ImageGenConfig`, `GenerateParams`, `GenerateResult`, `ComfyGraph` types; `buildComfyGraph(params: GenerateParams, config: ImageGenConfig): ComfyGraph`.

`GenerateParams` is the **fully resolved** shape (seed already chosen, defaults already applied by the caller is NOT assumed — `buildComfyGraph` applies config defaults for any `undefined` field EXCEPT `seed`, which the caller must resolve so the builder stays pure/deterministic).

- [ ] **Step 1: Write the types**

Create `server/lib/imagegen/types.ts`:

```ts
// server/lib/imagegen/types.ts
// Contracts for the ComfyUI + Qwen-Image generation path. The persisted config
// is one settings row (key='image_config'); ComfyGraph is the API-format prompt
// graph POSTed to ComfyUI.

export interface ImageGenConfig {
  baseURL: string | null   // ComfyUI endpoint, e.g. http://192.168.2.25:8188 (null = unconfigured)
  unetName: string         // diffusion model filename
  clipName: string         // text-encoder filename
  vaeName: string          // vae filename
  width: number            // default canvas width
  height: number           // default canvas height
  steps: number            // default sampler steps
  cfg: number              // default cfg scale
  sampler: string          // KSampler sampler_name
  scheduler: string        // KSampler scheduler
  workflowJson?: string    // optional override graph (JSON string); when set it replaces the template
}

/** Tool inputs after Zod parsing. `seed` is resolved by the caller before buildComfyGraph. */
export interface GenerateParams {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  seed: number             // resolved (never undefined at graph-build time)
  batchSize?: number       // EmptySD3LatentImage batch_size (default 1)
}

/** ComfyUI API-format graph: node-id -> { class_type, inputs }. */
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export type GenerateResult =
  | { ok: true; buffer: Buffer; mime: string; meta: { seed: number; width: number; height: number; steps: number; cfg: number } }
  | { ok: false; error: string }
```

- [ ] **Step 2: Write the failing test**

Create `server/lib/imagegen/graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildComfyGraph } from './graph'
import type { ImageGenConfig, GenerateParams } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'qwen_image_fp8_e4m3fn.safetensors',
  clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple'
}

describe('buildComfyGraph', () => {
  it('injects prompt, negative, size, steps, cfg, seed into the mapped nodes', () => {
    const params: GenerateParams = { prompt: 'a red bicycle', negativePrompt: 'blurry', seed: 42, steps: 8, cfg: 3, width: 768, height: 512 }
    const g = buildComfyGraph(params, config)
    expect(g['4'].inputs.text).toBe('a red bicycle')
    expect(g['5'].inputs.text).toBe('blurry')
    expect(g['6'].inputs.width).toBe(768)
    expect(g['6'].inputs.height).toBe(512)
    expect(g['6'].inputs.batch_size).toBe(1)
    expect(g['7'].inputs.seed).toBe(42)
    expect(g['7'].inputs.steps).toBe(8)
    expect(g['7'].inputs.cfg).toBe(3)
    expect(g['1'].inputs.unet_name).toBe(config.unetName)
    expect(g['2'].inputs.clip_name).toBe(config.clipName)
    expect(g['2'].inputs.type).toBe('qwen_image')
    expect(g['3'].inputs.vae_name).toBe(config.vaeName)
  })

  it('applies config defaults for omitted size/steps/cfg and empty negative', () => {
    const g = buildComfyGraph({ prompt: 'a cat', seed: 1 }, config)
    expect(g['6'].inputs.width).toBe(1024)
    expect(g['6'].inputs.height).toBe(1024)
    expect(g['7'].inputs.steps).toBe(20)
    expect(g['7'].inputs.cfg).toBe(2.5)
    expect(g['5'].inputs.text).toBe('')
  })

  it('honors batchSize on EmptySD3LatentImage', () => {
    const g = buildComfyGraph({ prompt: 'x', seed: 1, batchSize: 3 }, config)
    expect(g['6'].inputs.batch_size).toBe(3)
  })

  it('uses workflowJson override (with placeholder substitution) when set', () => {
    const tmpl = JSON.stringify({ '99': { class_type: 'X', inputs: { text: '%PROMPT%', seed: '%SEED%' } } })
    const g = buildComfyGraph({ prompt: 'hi', seed: 7 }, { ...config, workflowJson: tmpl })
    expect(g['99'].inputs.text).toBe('hi')
    expect(g['99'].inputs.seed).toBe(7)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run server/lib/imagegen/graph.test.ts`
Expected: FAIL with "Cannot find module './graph'" / "buildComfyGraph is not a function".

- [ ] **Step 4: Write the implementation**

Create `server/lib/imagegen/graph.ts`:

```ts
// server/lib/imagegen/graph.ts
// Pure builder: turn resolved generation params into a ComfyUI API-format graph.
// No I/O, no clock — the caller resolves `seed` so this stays deterministic/testable.
import type { ComfyGraph, GenerateParams, ImageGenConfig } from './types'

/**
 * Optional override path: a stored workflow JSON with %PROMPT% / %NEGATIVE% /
 * %SEED% / %WIDTH% / %HEIGHT% / %STEPS% / %CFG% placeholders. Numeric placeholders
 * are substituted as raw JSON numbers; string placeholders as JSON strings.
 */
function applyWorkflowOverride(json: string, params: GenerateParams, config: ImageGenConfig): ComfyGraph {
  const sub = json
    .replace(/"%PROMPT%"/g, JSON.stringify(params.prompt))
    .replace(/"%NEGATIVE%"/g, JSON.stringify(params.negativePrompt ?? ''))
    .replace(/"%SEED%"/g, String(params.seed))
    .replace(/"%WIDTH%"/g, String(params.width ?? config.width))
    .replace(/"%HEIGHT%"/g, String(params.height ?? config.height))
    .replace(/"%STEPS%"/g, String(params.steps ?? config.steps))
    .replace(/"%CFG%"/g, String(params.cfg ?? config.cfg))
  return JSON.parse(sub) as ComfyGraph
}

export function buildComfyGraph(params: GenerateParams, config: ImageGenConfig): ComfyGraph {
  if (config.workflowJson && config.workflowJson.trim()) {
    return applyWorkflowOverride(config.workflowJson, params, config)
  }
  const width = params.width ?? config.width
  const height = params.height ?? config.height
  const steps = params.steps ?? config.steps
  const cfg = params.cfg ?? config.cfg
  const batch = params.batchSize ?? 1
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: config.unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: config.clipName, type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: config.vaeName } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt ?? '', clip: ['2', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: batch } },
    '7': { class_type: 'KSampler', inputs: {
      seed: params.seed, steps, cfg, sampler_name: config.sampler, scheduler: config.scheduler, denoise: 1,
      model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0]
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mymind', images: ['8', 0] } }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run server/lib/imagegen/graph.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/lib/imagegen/types.ts server/lib/imagegen/graph.ts server/lib/imagegen/graph.test.ts
git commit -m "feat(imagegen): types + pure ComfyUI graph builder"
```

---

### Task 2: image_config store, defaults, and validation schema

**Files:**
- Create: `server/lib/imagegen/store.ts`
- Test: `server/lib/imagegen/store.test.ts`

**Interfaces:**
- Consumes: `ImageGenConfig` (Task 1).
- Produces: `defaultImageConfig(): ImageGenConfig`, `mergeImageConfig(raw): ImageGenConfig`, `imageConfigInputSchema` (Zod) + `parseImageConfigInput(raw): Partial<ImageGenConfig>`, and the DB I/O `loadImageConfig()`, `saveImageConfig(input)`, `invalidateImageConfig()` (mirrors `server/lib/search/store.ts`).

- [ ] **Step 1: Write the failing test**

Create `server/lib/imagegen/store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { defaultImageConfig, mergeImageConfig, parseImageConfigInput } from './store'

describe('defaultImageConfig', () => {
  it('defaults baseURL to null and carries the Qwen filenames + sane sampler defaults', () => {
    const d = defaultImageConfig()
    expect(d.baseURL).toBeNull()
    expect(d.unetName).toMatch(/qwen_image_fp8/)
    expect(d.width).toBe(1024)
    expect(d.steps).toBe(20)
    expect(d.cfg).toBe(2.5)
    expect(d.sampler).toBe('euler')
    expect(d.scheduler).toBe('simple')
  })
})

describe('mergeImageConfig', () => {
  it('fills gaps from defaults', () => {
    const m = mergeImageConfig({ baseURL: 'http://rig:8188', steps: 8 })
    expect(m.baseURL).toBe('http://rig:8188')
    expect(m.steps).toBe(8)
    expect(m.width).toBe(1024) // from default
  })
  it('returns a full default config for null/undefined', () => {
    expect(mergeImageConfig(null).baseURL).toBeNull()
  })
})

describe('parseImageConfigInput', () => {
  it('accepts a valid partial', () => {
    const p = parseImageConfigInput({ baseURL: 'http://rig:8188', steps: 12 })
    expect(p.baseURL).toBe('http://rig:8188')
    expect(p.steps).toBe(12)
  })
  it('accepts baseURL = null (unconfigured) and empty string -> null', () => {
    expect(parseImageConfigInput({ baseURL: null }).baseURL).toBeNull()
    expect(parseImageConfigInput({ baseURL: '' }).baseURL).toBeNull()
  })
  it('rejects a non-URL baseURL', () => {
    expect(() => parseImageConfigInput({ baseURL: 'not a url' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/imagegen/store.test.ts`
Expected: FAIL with "Cannot find module './store'".

- [ ] **Step 3: Write the implementation**

Create `server/lib/imagegen/store.ts`:

```ts
// server/lib/imagegen/store.ts
// Thin DB I/O for the single image_config JSONB row + an in-process cache.
// Mirrors server/lib/search/store.ts: module-level cache, explicit invalidation.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import type { ImageGenConfig } from './types'

const KEY = 'image_config'
let cache: ImageGenConfig | null = null

export function defaultImageConfig(): ImageGenConfig {
  return {
    baseURL: null,
    unetName: 'qwen_image_fp8_e4m3fn.safetensors',
    clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
    vaeName: 'qwen_image_vae.safetensors',
    width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple'
  }
}

export function mergeImageConfig(raw: Partial<ImageGenConfig> | null | undefined): ImageGenConfig {
  return { ...defaultImageConfig(), ...(raw ?? {}) }
}

// Empty-string baseURL -> null (unconfigured); otherwise must be a URL.
const baseURLSchema = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().url().nullable()
)

export const imageConfigInputSchema = z.object({
  baseURL: baseURLSchema.optional(),
  unetName: z.string().min(1).optional(),
  clipName: z.string().min(1).optional(),
  vaeName: z.string().min(1).optional(),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
  steps: z.number().int().min(1).max(60).optional(),
  cfg: z.number().min(0).max(20).optional(),
  sampler: z.string().min(1).optional(),
  scheduler: z.string().min(1).optional(),
  workflowJson: z.string().optional()
})

export function parseImageConfigInput(raw: unknown): Partial<ImageGenConfig> {
  return imageConfigInputSchema.parse(raw) as Partial<ImageGenConfig>
}

export async function loadImageConfig(): Promise<ImageGenConfig> {
  if (cache) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = mergeImageConfig(row?.value as Partial<ImageGenConfig> | undefined)
  return cache
}

export async function saveImageConfig(input: Partial<ImageGenConfig>): Promise<ImageGenConfig> {
  const current = await loadImageConfig()
  const next: ImageGenConfig = { ...current, ...input }
  await useDb().insert(settings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache = next
  return next
}

export function invalidateImageConfig(): void { cache = null }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/imagegen/store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/imagegen/store.ts server/lib/imagegen/store.test.ts
git commit -m "feat(imagegen): image_config store + defaults + validation schema"
```

---

### Task 3: ComfyUI HTTP client (submit / poll / fetch), never throws

**Files:**
- Create: `server/lib/imagegen/comfy.ts`
- Test: `server/lib/imagegen/comfy.test.ts`

**Interfaces:**
- Consumes: `buildComfyGraph` (Task 1), `loadImageConfig` (Task 2), types (Task 1).
- Produces:
  - `extractOutputImage(history: unknown, promptId: string): { filename: string; subfolder: string; type: string } | null` (pure).
  - `generateImage(params: { prompt: string; negativePrompt?: string; width?: number; height?: number; steps?: number; cfg?: number; seed?: number; batchSize?: number }, opts?: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number }): Promise<GenerateResult>` — never throws.

- [ ] **Step 1: Write the failing test**

Create `server/lib/imagegen/comfy.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractOutputImage, generateImage } from './comfy'
import type { ImageGenConfig } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'u', clipName: 'c', vaeName: 'v',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple'
}

afterEach(() => { vi.unstubAllGlobals() })

describe('extractOutputImage', () => {
  it('pulls the first node output with images[]', () => {
    const history = { p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }
    expect(extractOutputImage(history, 'p1')).toEqual({ filename: 'a.png', subfolder: '', type: 'output' })
  })
  it('returns null when the prompt id / outputs / images are absent', () => {
    expect(extractOutputImage({}, 'p1')).toBeNull()
    expect(extractOutputImage({ p1: { outputs: {} } }, 'p1')).toBeNull()
  })
})

describe('generateImage', () => {
  it('submits, polls until outputs, fetches bytes, returns ok', async () => {
    const png = new Uint8Array([1, 2, 3]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ prompt_id: 'p1' })                                   // POST /prompt
      .mockResolvedValueOnce({ p1: { outputs: {} } })                               // 1st /history (not ready)
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }) // 2nd /history
      .mockResolvedValueOnce(png)                                                   // GET /view -> ArrayBuffer
    vi.stubGlobal('$fetch', $fetch)
    const res = await generateImage({ prompt: 'a cat', seed: 5 }, { config, clientId: 'cid', pollIntervalMs: 1, maxWaitMs: 1000 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.mime).toBe('image/png')
      expect(res.buffer.length).toBe(3)
      expect(res.meta.seed).toBe(5)
    }
    // POST body carried the graph + client_id
    expect($fetch.mock.calls[0][0]).toContain('/prompt')
    expect($fetch.mock.calls[0][1].body.client_id).toBe('cid')
  })

  it('returns { ok:false } (no throw) when ComfyUI is unreachable', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config, pollIntervalMs: 1, maxWaitMs: 50 })
    expect(res).toEqual({ ok: false, error: expect.stringContaining('ECONNREFUSED') })
  })

  it('returns { ok:false, error } on poll timeout (outputs never arrive)', async () => {
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ prompt_id: 'p1' })
      .mockResolvedValue({ p1: { outputs: {} } }) // never ready
    vi.stubGlobal('$fetch', $fetch)
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config, pollIntervalMs: 1, maxWaitMs: 20 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/tim(e|ed) out/i)
  })

  it('returns { ok:false, error } when no baseURL is configured', async () => {
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config: { ...config, baseURL: null } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not configured/i)
  })

  it('aborts cleanly when the signal is already aborted', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ prompt_id: 'p1' }))
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config, signal: AbortSignal.abort(), pollIntervalMs: 1, maxWaitMs: 50 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/abort/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/imagegen/comfy.test.ts`
Expected: FAIL with "Cannot find module './comfy'".

- [ ] **Step 3: Write the implementation**

Create `server/lib/imagegen/comfy.ts`:

```ts
// server/lib/imagegen/comfy.ts
// ComfyUI client: POST /prompt -> poll /history -> GET /view. Never throws on an
// expected backend failure — returns { ok:false, error } (the web_fetch convention).
import { buildComfyGraph } from './graph'
import { loadImageConfig } from './store'
import type { GenerateParams, GenerateResult, ImageGenConfig } from './types'

// `$fetch` is Nitro's ambient global (ofetch) — used bare here exactly like
// server/lib/ai/embeddings.ts. Do NOT `declare const $fetch` (clashes with the
// ambient global type). Tests stub it via vi.stubGlobal('$fetch', ...).

const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? 'png'
  return MIME_BY_EXT[ext] ?? 'image/png'
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Pure: find the first node output carrying images[] for the given prompt id. */
export function extractOutputImage(history: unknown, promptId: string): { filename: string; subfolder: string; type: string } | null {
  const entry = (history as Record<string, { outputs?: Record<string, { images?: unknown[] }> }>)?.[promptId]
  const outputs = entry?.outputs
  if (!outputs) return null
  for (const node of Object.values(outputs)) {
    const img = node?.images?.[0] as { filename?: string; subfolder?: string; type?: string } | undefined
    if (img?.filename) return { filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' }
  }
  return null
}

function randomSeed(): number {
  // Normal server code (not a workflow script) — Math.random is allowed here.
  return Math.floor(Math.random() * 2 ** 32)
}

export async function generateImage(
  params: { prompt: string; negativePrompt?: string; width?: number; height?: number; steps?: number; cfg?: number; seed?: number; batchSize?: number },
  opts: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number } = {}
): Promise<GenerateResult> {
  const config = opts.config ?? await loadImageConfig()
  if (!config.baseURL) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings → Image Gen)' }

  const base = config.baseURL.replace(/\/$/, '')
  const seed = params.seed ?? randomSeed()
  const resolved: GenerateParams = { ...params, seed }
  const width = params.width ?? config.width
  const height = params.height ?? config.height
  const steps = params.steps ?? config.steps
  const cfg = params.cfg ?? config.cfg
  const clientId = opts.clientId ?? `mymind-${seed}-${Date.now()}`
  const pollIntervalMs = opts.pollIntervalMs ?? 1500
  const maxWaitMs = opts.maxWaitMs ?? 180_000

  if (opts.signal?.aborted) return { ok: false, error: 'aborted' }

  try {
    const graph = buildComfyGraph(resolved, config)
    const submit = await $fetch<{ prompt_id?: string }>(`${base}/prompt`, {
      method: 'POST', body: { prompt: graph, client_id: clientId }, signal: opts.signal
    })
    const promptId = submit?.prompt_id
    if (!promptId) return { ok: false, error: 'ComfyUI did not return a prompt_id' }

    const start = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
      if (Date.now() - start > maxWaitMs) return { ok: false, error: `image generation timed out after ${Math.round(maxWaitMs / 1000)}s` }
      const history = await $fetch(`${base}/history/${promptId}`, { signal: opts.signal })
      const out = extractOutputImage(history, promptId)
      if (out) {
        const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type })
        const ab = await $fetch<ArrayBuffer>(`${base}/view?${q.toString()}`, { responseType: 'arrayBuffer', signal: opts.signal })
        return { ok: true, buffer: Buffer.from(ab), mime: mimeFromName(out.filename), meta: { seed, width, height, steps, cfg } }
      }
      await sleep(pollIntervalMs)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
    return { ok: false, error: message }
  }
}
```

> Note on `responseType: 'arrayBuffer'`: ofetch returns the `ArrayBuffer` directly. The test stubs `$fetch` to resolve an `ArrayBuffer`, matching this.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/imagegen/comfy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/imagegen/comfy.ts server/lib/imagegen/comfy.test.ts
git commit -m "feat(imagegen): ComfyUI client (submit/poll/fetch), never-throws"
```

---

### Task 4: Pre-seeded image persistence (`createGeneratedImage`)

**Files:**
- Modify: `server/services/images.ts` (add a pure helper + the orchestrator)
- Test: `test/images-generated.test.ts`

**Interfaces:**
- Consumes: existing `processUpload`, `storage`, `useDb`, `images` schema; `embedOne` from `../lib/ai/embeddings`.
- Produces:
  - `buildGeneratedImageValues(args: { storageKey: string; mime: string; ext: string; kind: string; width: number | null; height: number | null; size: number; prompt: string; embedding: number[] | null }): Record<string, unknown>` (pure — the row values).
  - `createGeneratedImage(buffer: Buffer, mime: string, opts: { prompt: string }): Promise<Image>`.

- [ ] **Step 1: Write the failing test**

Create `test/images-generated.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildGeneratedImageValues } from '../server/services/images'

describe('buildGeneratedImageValues', () => {
  const base = { storageKey: 'k', mime: 'image/png', ext: 'png', kind: 'image', width: 1024, height: 1024, size: 999 }

  it('seeds the prompt as summary, marks enrich done, tags generated, and is private', () => {
    const v = buildGeneratedImageValues({ ...base, prompt: 'a red bicycle', embedding: [0.1, 0.2] })
    expect(v.summary).toBe('a red bicycle')
    expect(v.enrichStatus).toBe('done')
    expect(v.tags).toEqual(['generated'])
    expect(v.embedding).toEqual([0.1, 0.2])
    expect(v.isPublic).toBe(false)
    expect(v.makeDocument).toBe(false)
    expect(v.storageKey).toBe('k')
  })

  it('stores a null embedding when embedding failed', () => {
    const v = buildGeneratedImageValues({ ...base, prompt: 'x', embedding: null })
    expect(v.embedding).toBeNull()
    expect(v.summary).toBe('x')
    expect(v.enrichStatus).toBe('done') // still searchable by trigram on summary
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/images-generated.test.ts`
Expected: FAIL with "buildGeneratedImageValues is not a function".

- [ ] **Step 3: Write the implementation**

In `server/services/images.ts`, `embedOne` is **already imported** (line 8: `import { embedOne } from '../lib/ai/embeddings'`) and `Readable`, `storage`, `processUpload`, `useDb`, `images` are all already in scope (used by `createImage`). **Add no new imports.** Add the following two exports immediately after `createImage`:

```ts
/** Pure: the insert row for a generated image (prompt-seeded, enrich skipped). */
export function buildGeneratedImageValues(args: {
  storageKey: string; mime: string; ext: string; kind: string
  width: number | null; height: number | null; size: number
  prompt: string; embedding: number[] | null
}): Record<string, unknown> {
  return {
    storageKey: args.storageKey,
    originalName: null,
    mime: args.mime,
    ext: args.ext,
    kind: args.kind,
    width: args.width,
    height: args.height,
    size: args.size,
    summary: args.prompt,
    tags: ['generated'],
    enrichStatus: 'done',
    embedding: args.embedding as unknown,  // halfvec write idiom (see image-enrich.ts)
    isPublic: false,
    makeDocument: false
  }
}

/**
 * Persist a generated image WITHOUT the vision enrich pass: the prompt is the
 * summary + the embedding source, so the image is searchable immediately.
 */
export async function createGeneratedImage(buffer: Buffer, mime: string, opts: { prompt: string }): Promise<Image> {
  const processed = await processUpload(buffer, mime)
  const stream = Readable.from(processed.buffer)
  const { key, size } = await storage().put(stream, { contentType: processed.mime })

  let embedding: number[] | null = null
  try { embedding = await embedOne(opts.prompt) } catch (err) { console.warn('[imagegen] embed failed; storing null:', err) }

  const values = buildGeneratedImageValues({
    storageKey: key, mime: processed.mime, ext: processed.ext, kind: processed.kind,
    width: processed.width ?? null, height: processed.height ?? null, size,
    prompt: opts.prompt, embedding
  })
  const [row] = await useDb().insert(images).values(values as typeof images.$inferInsert).returning()
  return row!
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/images-generated.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck (the service touches Drizzle types)**

Run: `pnpm typecheck`
Expected: 0 errors. (If the `values as typeof images.$inferInsert` cast complains, ensure `embedding` is cast `as unknown` inside `buildGeneratedImageValues` — it already is.)

- [ ] **Step 6: Commit**

```bash
git add server/services/images.ts test/images-generated.test.ts
git commit -m "feat(images): createGeneratedImage — prompt-seeded, vision-skipped persist"
```

---

### Task 5: The `generate_image` agent tool

**Files:**
- Modify: `server/lib/agent/tools.ts` (add the tool to `agentTools`)
- Test: `test/generate-image-tool.test.ts`

**Interfaces:**
- Consumes: `generateImage` (Task 3), `createGeneratedImage` + `serveUrl` (Task 4 / existing), `publishChange`, `deleteImage` (existing in `images.ts`).
- Produces: a new entry in `agentTools` named `generate_image`.

- [ ] **Step 1: Write the failing test**

Create `test/generate-image-tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy deps the handler calls.
vi.mock('../server/lib/imagegen/comfy', () => ({ generateImage: vi.fn() }))
vi.mock('../server/services/images', () => ({
  createGeneratedImage: vi.fn(),
  deleteImage: vi.fn(),
  serveUrl: (row: { id: string }) => `/api/images/${row.id}/raw`
}))
vi.mock('../server/utils/live-bus', () => ({ publishChange: vi.fn() }))

import { agentTools } from '../server/lib/agent/tools'
import { generateImage } from '../server/lib/imagegen/comfy'
import { createGeneratedImage, deleteImage } from '../server/services/images'
import { publishChange } from '../server/utils/live-bus'

const tool = agentTools.find(t => t.name === 'generate_image')!
const ctx = { signal: new AbortController().signal }

beforeEach(() => { vi.clearAllMocks() })

describe('generate_image tool', () => {
  it('is registered, create-kind, and not dangerous (rides default toolset + MCP)', () => {
    expect(tool).toBeTruthy()
    expect(tool.kind).toBe('create')
    expect(tool.dangerous).toBeFalsy()
  })

  it('generates, persists, publishes, and returns id+url (with undo)', async () => {
    ;(generateImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([1]), mime: 'image/png', meta: { seed: 7, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any).mockResolvedValue({ id: 'img1', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'a red bicycle' }, ctx)
    const result = exec.result as { images: { id: string; url: string; seed: number }[] }
    expect(result.images[0].id).toBe('img1')
    expect(result.images[0].url).toBe('/api/images/img1/raw')
    expect(result.images[0].seed).toBe(7)
    expect(createGeneratedImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', { prompt: 'a red bicycle' })
    expect(publishChange).toHaveBeenCalledWith({ resource: 'image', action: 'created', id: 'img1' })
    await exec.undo!()
    expect(deleteImage).toHaveBeenCalledWith('img1')
  })

  it('returns a clean error result (no throw) when generation fails', async () => {
    ;(generateImage as any).mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(exec.summary).toMatch(/failed/i)
    expect(createGeneratedImage).not.toHaveBeenCalled()
  })

  it('generates n images sequentially', async () => {
    ;(generateImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([1]), mime: 'image/png', meta: { seed: 1, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any)
      .mockResolvedValueOnce({ id: 'a', isPublic: false, publicSlug: null })
      .mockResolvedValueOnce({ id: 'b', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'x', n: 2 }, ctx)
    expect((exec.result as { images: unknown[] }).images.length).toBe(2)
    expect(generateImage).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/generate-image-tool.test.ts`
Expected: FAIL (no `generate_image` in `agentTools`).

- [ ] **Step 3: Write the implementation**

In `server/lib/agent/tools.ts`, add imports at the top:

```ts
import { generateImage } from '../imagegen/comfy'
import { createGeneratedImage, deleteImage, serveUrl } from '../../services/images'
```

Add this entry to the `agentTools` array (place it after the `web_fetch` block, before `quick_capture`):

```ts
  // ---- image generation ----
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt using the local Qwen-Image model. The result is saved to the gallery and is searchable by its prompt. Returns the new image id(s) and URL(s). Generation takes ~1 minute per image. If it can\'t run (backend down / not configured) the result is { ok:false, error } — say so rather than retrying.',
    kind: 'create',
    schema: {
      prompt: z.string().min(1).describe('What to generate'),
      negative_prompt: z.string().optional().describe('What to avoid'),
      width: z.number().int().min(256).max(2048).optional(),
      height: z.number().int().min(256).max(2048).optional(),
      steps: z.number().int().min(1).max(60).optional(),
      cfg: z.number().min(0).max(20).optional(),
      seed: z.number().int().optional(),
      n: z.number().int().min(1).max(4).optional().describe('How many images (default 1)')
    },
    handler: async (a, ctx) => {
      const n = (a.n as number | undefined) ?? 1
      const params = {
        prompt: a.prompt as string,
        negativePrompt: a.negative_prompt as string | undefined,
        width: a.width as number | undefined,
        height: a.height as number | undefined,
        steps: a.steps as number | undefined,
        cfg: a.cfg as number | undefined,
        seed: a.seed as number | undefined
      }
      const made: { id: string; url: string; seed: number }[] = []
      for (let i = 0; i < n; i++) {
        if (ctx.signal.aborted) break
        const gen = await generateImage(params, { signal: ctx.signal })
        if (!gen.ok) {
          // Partial success: return what we made plus the error; nothing to clean up beyond `made`.
          if (made.length === 0) {
            return { result: { ok: false, error: gen.error }, summary: `image generation failed: ${gen.error}` }
          }
          break
        }
        const row = await createGeneratedImage(gen.buffer, gen.mime, { prompt: params.prompt })
        publishChange({ resource: 'image', action: 'created', id: row.id })
        made.push({ id: row.id, url: serveUrl(row), seed: gen.meta.seed })
      }
      return {
        result: { images: made, params: { prompt: params.prompt, negativePrompt: params.negativePrompt ?? null } },
        summary: made.length === 1 ? `generated image (${made[0]!.id})` : `generated ${made.length} images`,
        undo: async () => {
          for (const m of made) {
            await deleteImage(m.id)
            publishChange({ resource: 'image', action: 'deleted', id: m.id })
          }
        }
      }
    }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/generate-image-tool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent/tools.ts test/generate-image-tool.test.ts
git commit -m "feat(agent): generate_image tool (ComfyUI) — auto-exposed via MCP"
```

---

### Task 6: Settings API — get / put / test-connection

**Files:**
- Create: `server/api/settings/image-config.get.ts`
- Create: `server/api/settings/image-config.put.ts`
- Create: `server/api/settings/test-image-provider.post.ts`

**Interfaces:**
- Consumes: `loadImageConfig`, `saveImageConfig`, `parseImageConfigInput`, `invalidateImageConfig` (Task 2).
- Produces: `GET/PUT /api/settings/image-config`, `POST /api/settings/test-image-provider`.

> These are thin handlers mirroring `server/api/settings/search.{get,put}.ts` + `test-provider.post.ts`. Validation logic is the Zod schema unit-tested in Task 2; correctness here is covered by typecheck/build + the live E2E (Task 8). No new vitest.

- [ ] **Step 1: Create the GET handler**

Create `server/api/settings/image-config.get.ts`:

```ts
import { loadImageConfig } from '../../lib/imagegen/store'

export default defineEventHandler(async () => {
  return await loadImageConfig()  // no secrets in this config — safe to return whole
})
```

- [ ] **Step 2: Create the PUT handler**

Create `server/api/settings/image-config.put.ts`:

```ts
import { parseImageConfigInput, saveImageConfig } from '../../lib/imagegen/store'

export default defineEventHandler(async (event) => {
  let input
  try {
    input = parseImageConfigInput(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 422, message: (err as Error).message })
  }
  return await saveImageConfig(input)
})
```

- [ ] **Step 3: Create the test-connection handler**

Create `server/api/settings/test-image-provider.post.ts`:

```ts
// Ping ComfyUI to confirm it's reachable. Inline baseURL (a not-yet-saved form value)
// or omit to use the stored config.
import { z } from 'zod'
import { loadImageConfig } from '../../lib/imagegen/store'

const Body = z.object({ baseURL: z.string().url().nullable().optional() })

export default defineEventHandler(async (event) => {
  const b = Body.parse(await readBody(event).catch(() => ({})))
  const baseURL = b.baseURL ?? (await loadImageConfig()).baseURL
  if (!baseURL) return { ok: false, message: 'no baseURL configured' }
  try {
    const res = await $fetch.raw(`${baseURL.replace(/\/$/, '')}/system_stats`, { signal: AbortSignal.timeout(10000) })
    return { ok: res.status < 400, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
})
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/api/settings/image-config.get.ts server/api/settings/image-config.put.ts server/api/settings/test-image-provider.post.ts
git commit -m "feat(settings): image-config get/put + test-connection endpoints"
```

---

### Task 7: Settings UI — Image Gen tab + composable

**Files:**
- Create: `app/composables/useImageConfig.ts`
- Create: `app/components/settings/ImageGenTab.vue`
- Modify: `app/pages/settings.vue` (register the tab)

**Interfaces:**
- Consumes: `GET/PUT /api/settings/image-config`, `POST /api/settings/test-image-provider` (Task 6).
- Produces: `<SettingsImageGenTab />` (dir-prefixed auto-import) rendered in a new `image` tab slot.

> Verified via typecheck/build + the live playwright pass (Task 8). Mirror `app/components/settings/SearchTab.vue` (`SettingsSearchTab`) for layout/idiom; consult the `nuxt-ui-docs` skill for `UFormField`/`UInput`/`UButton` props if unsure.

- [ ] **Step 1: Create the composable**

Create `app/composables/useImageConfig.ts`:

```ts
// app/composables/useImageConfig.ts
export interface ImageConfig {
  baseURL: string | null
  unetName: string; clipName: string; vaeName: string
  width: number; height: number; steps: number; cfg: number
  sampler: string; scheduler: string; workflowJson?: string
}

export function useImageConfig() {
  const config = useState<ImageConfig | null>('image-config', () => null)
  const error = useState<string | null>('image-config-err', () => null)

  async function load() {
    config.value = await $fetch<ImageConfig>('/api/settings/image-config')
  }

  async function save(patch: Partial<ImageConfig>) {
    error.value = null
    try {
      config.value = await $fetch<ImageConfig>('/api/settings/image-config', { method: 'PUT', body: patch })
    } catch (e) {
      error.value = (e as { data?: { message?: string } }).data?.message ?? (e as Error).message
      throw e
    }
  }

  async function test(baseURL: string | null) {
    return await $fetch<{ ok: boolean; message: string }>('/api/settings/test-image-provider', { method: 'POST', body: { baseURL } })
  }

  return { config, error, load, save, test }
}
```

- [ ] **Step 2: Create the tab component**

Create `app/components/settings/ImageGenTab.vue`:

```vue
<script setup lang="ts">
const { config, error, load, save, test } = useImageConfig()
const saving = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

await load()
// local editable copy
const form = reactive({
  baseURL: config.value?.baseURL ?? '',
  unetName: config.value?.unetName ?? '',
  clipName: config.value?.clipName ?? '',
  vaeName: config.value?.vaeName ?? '',
  width: config.value?.width ?? 1024,
  height: config.value?.height ?? 1024,
  steps: config.value?.steps ?? 20,
  cfg: config.value?.cfg ?? 2.5,
  sampler: config.value?.sampler ?? 'euler',
  scheduler: config.value?.scheduler ?? 'simple'
})

async function onSave() {
  saving.value = true
  try { await save({ ...form, baseURL: form.baseURL.trim() || null }) } finally { saving.value = false }
}
async function onTest() {
  testResult.value = await test(form.baseURL.trim() || null)
}
</script>

<template>
  <div class="space-y-4 max-w-xl">
    <p class="text-sm text-muted">ComfyUI + Qwen-Image backend for the agent's <code>generate_image</code> tool.</p>
    <UFormField label="ComfyUI URL" help="e.g. http://192.168.2.25:8188">
      <UInput v-model="form.baseURL" placeholder="http://192.168.2.25:8188" class="w-full" />
    </UFormField>
    <UFormField label="UNET (diffusion) filename"><UInput v-model="form.unetName" class="w-full" /></UFormField>
    <UFormField label="CLIP (text encoder) filename"><UInput v-model="form.clipName" class="w-full" /></UFormField>
    <UFormField label="VAE filename"><UInput v-model="form.vaeName" class="w-full" /></UFormField>
    <div class="grid grid-cols-2 gap-3">
      <UFormField label="Width"><UInput v-model.number="form.width" type="number" /></UFormField>
      <UFormField label="Height"><UInput v-model.number="form.height" type="number" /></UFormField>
      <UFormField label="Steps"><UInput v-model.number="form.steps" type="number" /></UFormField>
      <UFormField label="CFG"><UInput v-model.number="form.cfg" type="number" step="0.1" /></UFormField>
      <UFormField label="Sampler"><UInput v-model="form.sampler" /></UFormField>
      <UFormField label="Scheduler"><UInput v-model="form.scheduler" /></UFormField>
    </div>
    <div class="flex items-center gap-3">
      <UButton :loading="saving" @click="onSave">Save</UButton>
      <UButton variant="soft" @click="onTest">Test connection</UButton>
      <span v-if="testResult" :class="testResult.ok ? 'text-green-500' : 'text-red-500'" class="text-sm">{{ testResult.message }}</span>
    </div>
    <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
  </div>
</template>
```

- [ ] **Step 3: Register the tab in `app/pages/settings.vue`**

Add to the `tabs` array (after the `secrets` entry):

```ts
  { label: 'Image Gen', icon: 'i-lucide-image', slot: 'imageGen' as const }
```

Add the template slot inside `<UTabs>` (after the `#secrets` template):

```vue
          <template #imageGen><SettingsImageGenTab /></template>
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 0 typecheck errors; build completes.

- [ ] **Step 5: Commit**

```bash
git add app/composables/useImageConfig.ts app/components/settings/ImageGenTab.vue app/pages/settings.vue
git commit -m "feat(settings): Image Gen tab — edit ComfyUI config + test connection"
```

---

### Task 8: Final wiring verification + docs

**Files:**
- Modify: `docs/wiki/agent.md` (or `docs/wiki/agent-tools.md` if that's where the tool surface is documented — confirm which) — add `generate_image` to the tool list + a short Image Gen config note.
- Modify: `docs/superpowers/plans/00-roadmap.md` — add the cycle-36 row.

> Per the `subagent-build-wiring-gap` memory: per-task green tests don't prove the module is wired in. This task is the integration gate.

- [ ] **Step 1: Full gate**

Run: `pnpm typecheck && pnpm vitest run && pnpm build`
Expected: typecheck 0; all tests pass (prior count + ~19 new); build clean.

- [ ] **Step 2: Verify MCP exposure (no code — confirm the auto-derivation)**

Confirm `server/lib/mcp/server.ts` iterates `agentTools` and that `generate_image` (non-`dangerous`) will be registered. Grep:

Run: `grep -n "agentTools" server/lib/mcp/server.ts`
Expected: the loop over `agentTools` is present (no per-tool registration needed).

- [ ] **Step 3: Update the wiki**

Add `generate_image` to the agent tool list in the wiki page and a one-paragraph "Image generation" note: config lives in `/settings → Image Gen` (`image_config` settings doc, NOT the ai_config registry); generated images skip vision enrich (prompt = summary); live preview / REST endpoint deferred. Bump the page's `status`/updated date.

- [ ] **Step 4: Add the roadmap row**

Add a cycle-36 row to `docs/superpowers/plans/00-roadmap.md` summarizing the shipped tool + the deferred items, linking the spec/plan/handover.

- [ ] **Step 5: Commit**

```bash
git add docs/wiki docs/superpowers/plans/00-roadmap.md
git commit -m "docs(imagegen): wiki + roadmap — generate_image tool shipped"
```

---

## Live verification (post-merge, against the real rig — acceptance)

Not vitest — run after merge with ComfyUI reachable (LAN), via playwright + the agent UI / MCP:

1. `/settings → Image Gen`: set the ComfyUI URL → **Test connection** returns HTTP 200.
2. Agent (powerful or default profile — no exec needed): `generate_image("a red bicycle on a beach")` → after ~1 min an image lands in the **gallery** (live, no refresh), the tool result has `{ id, url, seed }`.
3. The new gallery image's summary == the prompt; it's findable via search by a prompt word.
4. `width/height/steps/cfg/seed/negative_prompt` honored (pass `seed` twice → identical image).
5. Stop ComfyUI → `generate_image(...)` returns a clean error in chat, no crash, no spurious activity-log system error.
6. `n: 2` → two images created.

## Self-review notes (spec coverage)

- Spec §"Config lives in image_config" → Tasks 2, 6, 7.
- Spec §"Tool surface = agent + MCP" → Task 5 (+ Task 8 step 2 confirms MCP).
- Spec §"Synchronous, final image, abort + 180s cap" → Task 3 (`maxWaitMs`, `signal`).
- Spec §"Skip vision enrich; prompt→summary+embedding; tags ['generated']; no migration" → Task 4.
- Spec §"Never throw; clean error" → Tasks 3 (client) + 5 (tool).
- Spec §"Testing" → graph/store/comfy/persist/tool unit tests (Tasks 1–5) + live (acceptance).
- Spec §"Deferred" → documented in Task 8 wiki note; not built.
