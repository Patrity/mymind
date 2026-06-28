# Qwen-Image-Edit-2509 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `edit_image`'s img2img backend with **Qwen-Image-Edit-2509** (instruction-based editing) so "change the hat to a blue cowboy hat" actually edits the hat while preserving the subject.

**Architecture:** A new pure `buildQwenEditGraph` (the verified 2509 node graph) + edit-model fields on `image_config` + `editImage` repointed at the new graph (reusing the existing `uploadSourceImage`/poll/fetch flow) + the `edit_image` tool reverted to instruction prompts with a `quality` toggle. `generate_image` and the cycle-37 reliable-render path (model gets no URL; server authors the embed) are untouched. The old img2img engine is removed in a single isolated pass AFTER everything migrates onto the new one.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle (settings/images), Vitest, `$fetch` (ofetch incl. multipart), Nuxt UI v4.

## Global Constraints

- **Ordering is deliberate: ADD the new engine first (Tasks 1–5, fully additive — `pnpm typecheck` stays GREEN throughout), then REMOVE the old img2img engine in ONE isolated pass (Task 6) once nothing references it.** NEVER delete a type/function/test/doc to make a gate pass; the only deletions allowed are the explicit ones in Task 6.
- **Edit graph (verified on the rig 2026-06-26 — reproduce exactly):** `UNETLoader(37) → ModelSamplingAuraFlow(66, shift) → CFGNorm(75, strength 1) → KSampler(3)`; `LoadImage(78) → FluxKontextImageScale(117) → VAEEncode(88)`; two `TextEncodeQwenImageEditPlus` (111 positive = instruction, 110 negative = ''), each taking `clip(38)`, `vae(39)`, `image1(117)`; `VAEDecode(8)`; `SaveImage(9)`. KSampler: `model←75, positive←111, negative←110, latent_image←88`, `sampler_name 'euler'`, `scheduler 'simple'`, `denoise 1.0`.
- **Two model paths:** fast (default) = merged `qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors`, 4 steps, cfg 1.0. quality = unmerged `qwen_image_edit_2509_fp8_e4m3fn.safetensors`, 20 steps, cfg 2.5. shift 3.0 both. Reused encoder `qwen_2.5_vl_7b_fp8_scaled.safetensors` (CLIPLoader type `qwen_image`) + vae `qwen_image_vae.safetensors`.
- **Tools never throw on a backend failure** → `{ ok:false, error }`. `edit_image` is `kind:'create'`, NOT dangerous (MCP-exposed; tool surface stays 20). Model receives NO image URL (url only on `display` — cycle-37 invariant). `publishChange` after persist.
- **Package manager `pnpm`.** Gates: typecheck + test + build. Lint is red repo-wide — NOT a gate; ignore.
- App under repo-root `app/`; server under `server/`.

### Reference / current code (the things being changed)
- `server/lib/imagegen/types.ts`: `EditParams { prompt; negativePrompt?; steps?; cfg?; seed; strength? }`; `ImageGenConfig` has `editStrength` (being removed) + `unetName/clipName/vaeName/width/height/steps/cfg/sampler/scheduler/baseURL/workflowJson?`.
- `server/lib/imagegen/graph.ts`: `buildComfyGraph` (generate — KEEP), `buildImg2ImgGraph` (edit — REMOVE in Task 6).
- `server/lib/imagegen/comfy.ts`: `editImage(params{…,strength?…}, opts)` builds `buildImg2ImgGraph`; reuse its `uploadSourceImage`, `extractOutputImage`, `mimeToExt`, `mimeFromName`, `sleep`, `randomSeed`, the `$fetch` poll loop.
- `server/lib/agent/tools.ts`: `edit_image` (schema has `strength`; description says "full description"; passes `strength` to `editImage`).
- `server/lib/imagegen/store.ts`: `defaultImageConfig()` + `imageConfigInputSchema` (have `editStrength`).
- `app/composables/useImageConfig.ts` + `app/components/settings/ImageGenTab.vue`: `editStrength` field.
- `server/services/images.ts` `createGeneratedImage(buffer, mime, {prompt, tags?})` — unchanged, reused.

---

### Task 1: Config — add edit-model fields (additive; keep editStrength)

**Files:**
- Modify: `server/lib/imagegen/types.ts`, `server/lib/imagegen/store.ts`
- Test: `server/lib/imagegen/store.test.ts`

**Interfaces:**
- Produces: `ImageGenConfig` gains `editUnetName`, `editSteps`, `editCfg`, `editUnetQualityName`, `editStepsQuality`, `editCfgQuality`, `editShift`; `defaultImageConfig()` returns them; `imageConfigInputSchema` validates them.

- [ ] **Step 1: Extend the type** — in `server/lib/imagegen/types.ts`, add these fields to `ImageGenConfig` (after `scheduler`, before `editStrength` — keep `editStrength` for now):

```ts
  editUnetName: string         // fast/default edit model (merged lightning, 4-step)
  editSteps: number            // fast edit steps
  editCfg: number              // fast edit cfg
  editUnetQualityName: string  // quality edit model (unmerged, 20-step)
  editStepsQuality: number     // quality edit steps
  editCfgQuality: number       // quality edit cfg
  editShift: number            // ModelSamplingAuraFlow shift for edits
```

- [ ] **Step 2: Failing test** — append to `server/lib/imagegen/store.test.ts`:

```ts
describe('edit-model config', () => {
  it('defaults to the merged fast model + unmerged quality model + shift, and validates', async () => {
    const { defaultImageConfig, parseImageConfigInput } = await import('./store')
    const d = defaultImageConfig()
    expect(d.editUnetName).toMatch(/lightning4/)
    expect(d.editSteps).toBe(4)
    expect(d.editCfg).toBe(1.0)
    expect(d.editUnetQualityName).toBe('qwen_image_edit_2509_fp8_e4m3fn.safetensors')
    expect(d.editStepsQuality).toBe(20)
    expect(d.editCfgQuality).toBe(2.5)
    expect(d.editShift).toBe(3.0)
    expect(parseImageConfigInput({ editSteps: 6 }).editSteps).toBe(6)
    expect(() => parseImageConfigInput({ editSteps: 0 })).toThrow()
  })
})
```

- [ ] **Step 3: Run it** — `pnpm vitest run server/lib/imagegen/store.test.ts` → the new case FAILS.

- [ ] **Step 4: Implement** — in `server/lib/imagegen/store.ts`:
  - In `defaultImageConfig()` return object add (after `editStrength`):

```ts
    editUnetName: 'qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors',
    editSteps: 4,
    editCfg: 1.0,
    editUnetQualityName: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
    editStepsQuality: 20,
    editCfgQuality: 2.5,
    editShift: 3.0,
```
  - In `imageConfigInputSchema` add:

```ts
    editUnetName: z.string().min(1).optional(),
    editSteps: z.number().int().min(1).max(60).optional(),
    editCfg: z.number().min(0).max(20).optional(),
    editUnetQualityName: z.string().min(1).optional(),
    editStepsQuality: z.number().int().min(1).max(60).optional(),
    editCfgQuality: z.number().min(0).max(20).optional(),
    editShift: z.number().min(0).max(10).optional(),
```

- [ ] **Step 5: Run + typecheck** — `pnpm vitest run server/lib/imagegen/store.test.ts` PASS; `pnpm typecheck` → 0 (additive — green).

- [ ] **Step 6: Commit**

```bash
git add server/lib/imagegen/types.ts server/lib/imagegen/store.ts server/lib/imagegen/store.test.ts
git commit -m "feat(imagegen): add Qwen-Image-Edit model config fields"
```

---

### Task 2: `buildQwenEditGraph` (pure; additive — keep buildImg2ImgGraph)

**Files:**
- Modify: `server/lib/imagegen/graph.ts`
- Test: `server/lib/imagegen/qwen-edit-graph.test.ts`

**Interfaces:**
- Consumes: `EditParams`, `ImageGenConfig` (incl. Task 1 fields).
- Produces: `buildQwenEditGraph(params: EditParams, config: ImageGenConfig, sourceFilename: string, opts?: { quality?: boolean }): ComfyGraph`.

- [ ] **Step 1: Failing test** — create `server/lib/imagegen/qwen-edit-graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildQwenEditGraph } from './graph'
import type { ImageGenConfig, EditParams } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'qwen_image_fp8_e4m3fn.safetensors',
  clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple',
  editStrength: 0.72,
  editUnetName: 'qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors',
  editSteps: 4, editCfg: 1.0,
  editUnetQualityName: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
  editStepsQuality: 20, editCfgQuality: 2.5, editShift: 3.0
}

describe('buildQwenEditGraph', () => {
  it('wires the verified Qwen-Image-Edit-2509 graph (fast/default path)', () => {
    const params: EditParams = { prompt: 'change the hat to a blue cowboy hat', negativePrompt: '', seed: 42 }
    const g = buildQwenEditGraph(params, config, 'src.png')
    // loaders
    expect(g['37'].class_type).toBe('UNETLoader')
    expect(g['37'].inputs.unet_name).toBe(config.editUnetName)   // merged fast model
    expect(g['38'].inputs.clip_name).toBe(config.clipName)
    expect(g['38'].inputs.type).toBe('qwen_image')
    expect(g['39'].inputs.vae_name).toBe(config.vaeName)
    // model chain
    expect(g['66'].class_type).toBe('ModelSamplingAuraFlow')
    expect(g['66'].inputs.model).toEqual(['37', 0])
    expect(g['66'].inputs.shift).toBe(3.0)
    expect(g['75'].class_type).toBe('CFGNorm')
    expect(g['75'].inputs.model).toEqual(['66', 0])
    // source chain
    expect(g['78'].class_type).toBe('LoadImage')
    expect(g['78'].inputs.image).toBe('src.png')
    expect(g['117'].class_type).toBe('FluxKontextImageScale')
    expect(g['117'].inputs.image).toEqual(['78', 0])
    expect(g['88'].class_type).toBe('VAEEncode')
    expect(g['88'].inputs.pixels).toEqual(['117', 0])
    expect(g['88'].inputs.vae).toEqual(['39', 0])
    // conditioning
    expect(g['111'].class_type).toBe('TextEncodeQwenImageEditPlus')
    expect(g['111'].inputs.prompt).toBe('change the hat to a blue cowboy hat')
    expect(g['111'].inputs.image1).toEqual(['117', 0])
    expect(g['111'].inputs.clip).toEqual(['38', 0])
    expect(g['111'].inputs.vae).toEqual(['39', 0])
    expect(g['110'].inputs.prompt).toBe('')
    // sampler
    expect(g['3'].inputs.model).toEqual(['75', 0])
    expect(g['3'].inputs.positive).toEqual(['111', 0])
    expect(g['3'].inputs.negative).toEqual(['110', 0])
    expect(g['3'].inputs.latent_image).toEqual(['88', 0])
    expect(g['3'].inputs.steps).toBe(4)
    expect(g['3'].inputs.cfg).toBe(1.0)
    expect(g['3'].inputs.denoise).toBe(1.0)
    expect(g['8'].inputs.samples).toEqual(['3', 0])
    expect(g['9'].class_type).toBe('SaveImage')
  })

  it('quality path selects the unmerged model + 20 steps + cfg 2.5', () => {
    const g = buildQwenEditGraph({ prompt: 'x', seed: 1 }, config, 'a.png', { quality: true })
    expect(g['37'].inputs.unet_name).toBe(config.editUnetQualityName)
    expect(g['3'].inputs.steps).toBe(20)
    expect(g['3'].inputs.cfg).toBe(2.5)
  })
})
```

- [ ] **Step 2: Run it** — `pnpm vitest run server/lib/imagegen/qwen-edit-graph.test.ts` → FAIL ("buildQwenEditGraph is not a function").

- [ ] **Step 3: Implement** — append to `server/lib/imagegen/graph.ts`:

```ts
/**
 * Qwen-Image-Edit-2509 instruction edit graph (verified on the rig 2026-06-26). The
 * merged lightning model is the default; `opts.quality` selects the unmerged 20-step
 * model. Source image: LoadImage -> FluxKontextImageScale (auto-resolution) -> VAEEncode
 * (latent) AND -> image1 of both TextEncodeQwenImageEditPlus nodes (the reference the
 * edit conditions on). Pure — caller resolves `seed`.
 */
export function buildQwenEditGraph(params: EditParams, config: ImageGenConfig, sourceFilename: string, opts: { quality?: boolean } = {}): ComfyGraph {
  const unet = opts.quality ? config.editUnetQualityName : config.editUnetName
  const steps = params.steps ?? (opts.quality ? config.editStepsQuality : config.editSteps)
  const cfg = params.cfg ?? (opts.quality ? config.editCfgQuality : config.editCfg)
  return {
    '37': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '38': { class_type: 'CLIPLoader', inputs: { clip_name: config.clipName, type: 'qwen_image' } },
    '39': { class_type: 'VAELoader', inputs: { vae_name: config.vaeName } },
    '66': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['37', 0], shift: config.editShift } },
    '75': { class_type: 'CFGNorm', inputs: { model: ['66', 0], strength: 1.0 } },
    '78': { class_type: 'LoadImage', inputs: { image: sourceFilename } },
    '117': { class_type: 'FluxKontextImageScale', inputs: { image: ['78', 0] } },
    '88': { class_type: 'VAEEncode', inputs: { pixels: ['117', 0], vae: ['39', 0] } },
    '111': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['38', 0], vae: ['39', 0], image1: ['117', 0], prompt: params.prompt } },
    '110': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['38', 0], vae: ['39', 0], image1: ['117', 0], prompt: params.negativePrompt ?? '' } },
    '3': { class_type: 'KSampler', inputs: {
      seed: params.seed, steps, cfg, sampler_name: config.sampler, scheduler: config.scheduler, denoise: 1.0,
      model: ['75', 0], positive: ['111', 0], negative: ['110', 0], latent_image: ['88', 0]
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mymind-edit', images: ['8', 0] } }
  }
}
```

- [ ] **Step 4: Run + typecheck** — `pnpm vitest run server/lib/imagegen/qwen-edit-graph.test.ts` PASS (2); `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add server/lib/imagegen/graph.ts server/lib/imagegen/qwen-edit-graph.test.ts
git commit -m "feat(imagegen): buildQwenEditGraph (Qwen-Image-Edit-2509 graph)"
```

---

### Task 3: `editImage` → Qwen-Image-Edit graph + `quality` (drop strength)

**Files:**
- Modify: `server/lib/imagegen/comfy.ts`
- Test: `server/lib/imagegen/edit.test.ts`

**Interfaces:**
- Produces: `editImage(params: { prompt: string; negativePrompt?: string; seed?: number; sourceBytes: Buffer; sourceMime: string }, opts?: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number; quality?: boolean }): Promise<GenerateResult>`.

- [ ] **Step 1: Update the tests** — in `server/lib/imagegen/edit.test.ts`: remove any `strength` from the `editImage` calls; change the happy-path assertion to confirm the submitted graph is the QWEN EDIT graph and the quality flag selects the unet. Replace the `editImage` describe's happy-path test body with:

```ts
  it('uploads the source, submits the Qwen edit graph, polls, fetches bytes, returns ok', async () => {
    const png = new Uint8Array([1, 2, 3]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ name: 'src.png', subfolder: '', type: 'input' })       // POST /upload/image
      .mockResolvedValueOnce({ prompt_id: 'p1' })                                      // POST /prompt
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } })
      .mockResolvedValueOnce(png)
    vi.stubGlobal('$fetch', $fetch)
    const res = await editImage({ ...src, prompt: 'make it a cowboy hat', seed: 5 }, { config, clientId: 'cid', pollIntervalMs: 1, maxWaitMs: 1000 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.buffer.length).toBe(3)
    expect(String($fetch.mock.calls[0]?.[0])).toContain('/upload/image')
    // the submitted /prompt body carries the Qwen edit graph (fast model by default)
    const graph = ($fetch.mock.calls[1]?.[1] as { body: { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> } }).body.prompt
    expect(graph['111'].class_type).toBe('TextEncodeQwenImageEditPlus')
    expect(graph['37'].inputs.unet_name).toBe(config.editUnetName)
  })

  it('quality:true submits the unmerged quality model', async () => {
    const png = new Uint8Array([1]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ name: 'src.png', subfolder: '', type: 'input' })
      .mockResolvedValueOnce({ prompt_id: 'p1' })
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } })
      .mockResolvedValueOnce(png)
    vi.stubGlobal('$fetch', $fetch)
    await editImage({ ...src, prompt: 'x', seed: 1 }, { config, quality: true, pollIntervalMs: 1, maxWaitMs: 1000 })
    const graph = ($fetch.mock.calls[1]?.[1] as { body: { prompt: Record<string, { inputs: Record<string, unknown> }> } }).body.prompt
    expect(graph['37'].inputs.unet_name).toBe(config.editUnetQualityName)
    expect(graph['3'].inputs.steps).toBe(20)
  })
```

(Keep the existing unreachable / no-baseURL `editImage` tests + the `uploadSourceImage` tests; just drop any `strength` arg from their calls. Ensure the test-file `config` literal includes the Task-1 edit fields — copy the literal from the qwen-edit-graph test.)

- [ ] **Step 2: Run it** — `pnpm vitest run server/lib/imagegen/edit.test.ts` → the graph-shape assertions FAIL (still img2img).

- [ ] **Step 3: Implement** — in `server/lib/imagegen/comfy.ts`:
  - Add `buildQwenEditGraph` to the existing `./graph` import; you may leave the `buildImg2ImgGraph` import (removed in Task 6).
  - Replace the `editImage` signature + body up to the graph build:

```ts
export async function editImage(
  params: { prompt: string; negativePrompt?: string; seed?: number; sourceBytes: Buffer; sourceMime: string },
  opts: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number; quality?: boolean } = {}
): Promise<GenerateResult> {
  try {
    const config = opts.config ?? await loadImageConfig()
    if (!config.baseURL) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings -> Image Gen)' }
    const base = config.baseURL.replace(/\/$/, '')
    const seed = params.seed ?? randomSeed()
    const quality = opts.quality ?? false
    const steps = quality ? config.editStepsQuality : config.editSteps
    const cfg = quality ? config.editCfgQuality : config.editCfg
    const clientId = opts.clientId ?? `mymind-edit-${seed}-${Date.now()}`
    const pollIntervalMs = opts.pollIntervalMs ?? 1500
    const maxWaitMs = opts.maxWaitMs ?? 180_000
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }

    const ext = mimeToExt(params.sourceMime)
    const up = await uploadSourceImage(params.sourceBytes, `mymind-src-${seed}.${ext}`, { config, signal: opts.signal })
    if (!up.ok) return up

    const graph = buildQwenEditGraph({ prompt: params.prompt, negativePrompt: params.negativePrompt, seed }, config, up.name, { quality })
```
  - The rest of `editImage` (POST /prompt, poll /history, GET /view) is unchanged. In the success `return`, set the meta — edit output dims are decided by FluxKontextImageScale and re-read from the result buffer at persist, so they are not known here:

```ts
        return { ok: true, buffer: Buffer.from(ab), mime: mimeFromName(out.filename), meta: { seed, width: 0, height: 0, steps, cfg } }
```

- [ ] **Step 4: Run + typecheck** — `pnpm vitest run server/lib/imagegen/edit.test.ts` PASS; `pnpm typecheck` → 0 (buildImg2ImgGraph now unused but still present — fine).

- [ ] **Step 5: Commit**

```bash
git add server/lib/imagegen/comfy.ts server/lib/imagegen/edit.test.ts
git commit -m "feat(imagegen): editImage uses Qwen-Image-Edit graph + quality toggle"
```

---

### Task 4: `edit_image` tool — instruction prompt + `quality` (drop strength)

**Files:**
- Modify: `server/lib/agent/tools.ts`
- Test: `test/edit-image-tool.test.ts`

**Interfaces:**
- Consumes: `editImage` (Task 3).

- [ ] **Step 1: Update the tests** — in `test/edit-image-tool.test.ts`: drop any `strength` references; add a quality-forwarding assertion. In the happy-path test, after the existing assertions add:

```ts
    // quality flag is forwarded to editImage
    await tool.handler({ prompt: 'make it a cowboy hat', quality: true }, ctx)
    expect((editImage as any).mock.calls.at(-1)[1].quality).toBe(true)
```
(The `editImage` mock already exists; ensure the happy-path mock is set so the second call also resolves ok — or add a dedicated `it('forwards quality')` block that sets `(editImage as any).mockResolvedValue({ ok:true, ... })` + `(createGeneratedImage as any).mockResolvedValue({ id:'e2', isPublic:false, publicSlug:null })` and asserts `.mock.calls.at(-1)[1].quality === true`.)

- [ ] **Step 2: Run it** — `pnpm vitest run test/edit-image-tool.test.ts` → the quality assertion FAILS (no quality wired).

- [ ] **Step 3: Implement** — in `server/lib/agent/tools.ts`, the `edit_image` entry:
  - Description → instruction-based:

```ts
    description: 'Edit an existing image with an instruction (local Qwen-Image-Edit): describe the change, e.g. "change the hat to a blue cowboy hat". It edits the named part while preserving the rest of the image. By default edits the most recently generated image; pass source_image_id to edit a specific one. Set quality:true for a slower, higher-fidelity 20-step pass (default is the fast 4-step model). The result is shown to the user automatically — do NOT write an image link. On failure the result is { ok:false, error }.',
```
  - Schema: remove `strength`; add `quality: z.boolean().optional().describe('Slower 20-step high-fidelity pass (default fast 4-step)')`.
  - Handler: drop `strength` from the params passed to `editImage`; pass `quality`:

```ts
      const gen = await editImage({
        prompt, negativePrompt: a.negative_prompt as string | undefined,
        seed: a.seed as number | undefined,
        sourceBytes: src.bytes, sourceMime: src.mime
      }, { signal: ctx.signal, quality: a.quality as boolean | undefined })
```

- [ ] **Step 4: Run + typecheck** — `pnpm vitest run test/edit-image-tool.test.ts` PASS; `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts test/edit-image-tool.test.ts
git commit -m "feat(agent): edit_image instruction prompt + quality toggle (Qwen-Image-Edit)"
```

---

### Task 5: Settings UI — add edit-model fields (additive; keep editStrength field)

**Files:**
- Modify: `app/composables/useImageConfig.ts`, `app/components/settings/ImageGenTab.vue`

> Verified by typecheck + build. Mirror the existing field idiom in the tab.

- [ ] **Step 1: Composable** — in `app/composables/useImageConfig.ts`, add to the `ImageConfig` interface (after `scheduler`, keep `editStrength`):

```ts
  editUnetName: string
  editSteps: number
  editCfg: number
  editUnetQualityName: string
  editStepsQuality: number
  editCfgQuality: number
  editShift: number
```

- [ ] **Step 2: Tab** — in `app/components/settings/ImageGenTab.vue`:
  - Add to the `form` reactive (with defaults): `editUnetName: '', editSteps: 4, editCfg: 1.0, editUnetQualityName: '', editStepsQuality: 20, editCfgQuality: 2.5, editShift: 3.0`.
  - In the `onMounted` population block add: `form.editUnetName = config.value.editUnetName ?? ''` … and the same for the other six (mirroring the existing `form.x = config.value.x ?? <default>` lines).
  - Add a fieldset of inputs mirroring the existing ones (an "Edit model (instruction editing)" group): text `editUnetName`, number `editSteps` (`:min="1" :max="60"`), number `editCfg` (`step="0.1" :min="0" :max="20"`), text `editUnetQualityName`, number `editStepsQuality`, number `editCfgQuality`, number `editShift` (`step="0.1" :min="0" :max="10"`). All `v-model.number` for numbers; ensure they're in the `save({ ...form, ... })` payload (the existing save spreads `form`).

- [ ] **Step 3: Typecheck + build** — `pnpm typecheck && pnpm build` → 0 / completes.

- [ ] **Step 4: Commit**

```bash
git add app/composables/useImageConfig.ts app/components/settings/ImageGenTab.vue
git commit -m "feat(settings): edit-model config fields (Qwen-Image-Edit)"
```

---

### Task 6: Remove the img2img engine (isolated deletion pass)

**Files:**
- Modify: `server/lib/imagegen/graph.ts`, `server/lib/imagegen/types.ts`, `server/lib/imagegen/store.ts`, `server/lib/imagegen/store.test.ts`, `server/lib/imagegen/comfy.ts`, `app/composables/useImageConfig.ts`, `app/components/settings/ImageGenTab.vue`
- Delete: `server/lib/imagegen/img2img-graph.test.ts`

> Everything now uses `buildQwenEditGraph` / the edit-model config, so the img2img engine + `editStrength` are dead. This task removes ONLY those. Do NOT remove anything else.

- [ ] **Step 1: Verify nothing live references the targets** — run:

```bash
grep -rn "buildImg2ImgGraph\|editStrength\|\.strength" server app test | grep -v "node_modules"
```
Expected references ONLY in: `graph.ts` (the function def), `comfy.ts` (the now-unused import), `types.ts`/`store.ts`/`store.test.ts`/`useImageConfig.ts`/`ImageGenTab.vue` (editStrength), and `img2img-graph.test.ts` (to be deleted). If `.strength` appears anywhere in `editImage`/`edit_image` handler/`buildQwenEditGraph`, STOP — Task 3/4 missed a spot; fix that first.

- [ ] **Step 2: Delete** — remove:
  - `server/lib/imagegen/graph.ts`: the entire `buildImg2ImgGraph` function.
  - `server/lib/imagegen/img2img-graph.test.ts`: `git rm` the file.
  - `server/lib/imagegen/comfy.ts`: drop `buildImg2ImgGraph` from the `./graph` import.
  - `server/lib/imagegen/types.ts`: remove `editStrength` from `ImageGenConfig`; remove `strength?` and the now-unused `steps?`/`cfg?` from `EditParams` ONLY IF nothing references them — `buildQwenEditGraph` reads `params.steps`/`params.cfg`, so KEEP `steps?`/`cfg?`; remove only `strength?`.
  - `server/lib/imagegen/store.ts`: remove `editStrength` from `defaultImageConfig()` and `imageConfigInputSchema`.
  - `server/lib/imagegen/store.test.ts`: remove the `editStrength` test (the one asserting `defaultImageConfig().editStrength`).
  - **Test config literals:** remove the `editStrength: 0.72` line from the `ImageGenConfig` literals in `server/lib/imagegen/qwen-edit-graph.test.ts` and `server/lib/imagegen/edit.test.ts` (and any other test that builds an `ImageGenConfig` literal) — once `editStrength` is off the interface, leaving it in a typed literal is a TS2353 excess-property error. The Step 1 grep lists every such site.
  - `app/composables/useImageConfig.ts`: remove `editStrength` from the interface.
  - `app/components/settings/ImageGenTab.vue`: remove the `editStrength` line from `form`, its `onMounted` population line, and its `UFormField`/input.

- [ ] **Step 3: Verify the targets are gone** — re-run the grep from Step 1; expect NO matches for `buildImg2ImgGraph`, `editStrength`, or `.strength`.

- [ ] **Step 4: Full gate** — `pnpm typecheck` → 0; `pnpm vitest run` → all pass; `pnpm build` → completes. (If typecheck flags a leftover reference, fix the reference — do NOT re-add the removed symbol.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(imagegen): remove img2img edit engine + editStrength (superseded by Qwen-Image-Edit)"
```

---

### Task 7: Final wiring verification + docs

**Files:**
- Modify: `docs/wiki/agent.md`, `docs/wiki/mcp.md`, `docs/superpowers/plans/00-roadmap.md`

- [ ] **Step 1: Full gate** — `pnpm typecheck && pnpm vitest run && pnpm build`. Report typecheck 0; the ACTUAL file/test counts (the qwen-edit-graph test replaces img2img-graph; edit/store/edit-image tests changed — report what you see); build clean. If anything fails, STOP and report BLOCKED.

- [ ] **Step 2: Confirm MCP** — `grep -n "agentTools" server/lib/mcp/server.ts`; `edit_image` is still non-dangerous → count stays 20; `test/mcp-parity.test.ts` passes unchanged. Report.

- [ ] **Step 3: Wiki** — `docs/wiki/agent.md`: update the `edit_image` row + the Image-editing section to describe **Qwen-Image-Edit-2509 instruction editing** (instruction prompt; fast merged 4-step default + `quality` 20-step toggle; reuses the encoder/VAE; FluxKontextImageScale auto-resolution), and note **img2img + editStrength were removed**. Keep the cycle-37 reliable-render description. Bump `updated`/`cycle` to 38 / 2026-06-26. `docs/wiki/mcp.md`: update the `edit_image` row description (count unchanged at 20; bump `updated`).

- [ ] **Step 4: Roadmap** — add a **cycle-38** row to `docs/superpowers/plans/00-roadmap.md` after cycle 37 (no renumbering): Qwen-Image-Edit-2509 instruction editing replaces img2img; ✅ shipped; link spec (`../specs/2026-06-26-qwen-image-edit-design.md`), this plan, and handover `../../handovers/2026-06-26-qwen-image-edit.md` (controller writes it).

- [ ] **Step 5: Commit**

```bash
git add docs/wiki docs/superpowers/plans/00-roadmap.md
git commit -m "docs(imagegen): wiki + roadmap — Qwen-Image-Edit-2509 (cycle 38)"
```

---

## Live verification (post-merge, against the rig — acceptance)

1. `/agent`: "generate a cat in a top hat" → image inline. "change the hat to a blue cowboy hat" (no id) → the hat changes to a blue cowboy hat, SAME cat/background preserved (not a different image), ~14 s, renders inline (one image, no duplicate), in the gallery tagged `generated,edited`.
2. `quality:true` (ask Bridget for a "high quality" edit) → the 20-step unmerged path runs (slower, sharper).
3. Stop ComfyUI → `edit_image` returns a clean error, no crash. Model never shows a fabricated/old image.

## Self-review notes (spec coverage)
- Spec "new graph (verified node table)" → Task 2 (`buildQwenEditGraph`) + Task 3 (editImage uses it).
- Spec "fast default + quality toggle" → Tasks 1 (config), 2 (graph opts), 3 (editImage), 4 (tool flag).
- Spec "instruction prompt; drop strength" → Task 4.
- Spec "remove img2img + editStrength" → Task 6 (isolated, after migration).
- Spec "reuse uploadSourceImage + reliable-render; never-throws; not dangerous; tags generated,edited" → Task 3/4 (unchanged paths).
- Spec "config edit fields + settings UI" → Tasks 1, 5.
- Spec "testing" → graph/editImage/tool/config unit tests + live acceptance.
- Spec "deferred (multi-image, Phase 2, resolution override)" → not built.
