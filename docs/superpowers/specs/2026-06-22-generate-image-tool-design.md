---
title: generate_image agent tool (ComfyUI + Qwen-Image)
status: approved
date: 2026-06-22
cycle: 36 (Cycle B-adjacent feature)
task: cb4cf239 (MyMind-side integration)
related:
  - homelab task "ComfyUI + Qwen-Image image generation on GPU 0" (backend, live)
  - docs/wiki/agent.md (agent tool surface)
  - server/lib/search/* (search_config precedent for a separate settings doc)
---

# generate_image agent tool (ComfyUI + Qwen-Image)

Give MyMind agents — and, for free, MCP clients — a `generate_image` tool that renders
images via the homelab ComfyUI + Qwen-Image backend and ingests each result into the
MyMind library (gallery + search). Config lives in the DB (swappable in-app, no env, no
redeploy), per the locked cycle-12 decision. The ComfyUI backend is already deployed and
verified (2026-06-19); this cycle is the **MyMind-side integration only**.

## Backend (live — no work here)

- ComfyUI on the AI Rig PNY GPU: `http://192.168.2.25:8188` (LAN, no auth). systemd `comfyui.service`.
- Model: **Qwen-Image fp8** (native, no offload).
  - diffusion (UNET): `qwen_image_fp8_e4m3fn.safetensors`
  - text encoder (CLIP): `qwen_2.5_vl_7b_fp8_scaled.safetensors` (CLIPLoader `type: "qwen_image"`)
  - vae: `qwen_image_vae.safetensors`
- API flow:
  1. `POST /prompt` `{ prompt: <graph>, client_id }` → `{ prompt_id }`
  2. poll `GET /history/<prompt_id>` until `entry.outputs` is present
  3. fetch bytes at `GET /view?filename=<f>&subfolder=<s>&type=output`
  4. (optional, NOT used in v1) `/ws?clientId=` streams progress + latent previews
- Working graph (API format), 9 nodes:

  | # | node | key params |
  |---|---|---|
  | 1 | `UNETLoader` | `unet_name` |
  | 2 | `CLIPLoader` | `clip_name`, `type: "qwen_image"` |
  | 3 | `VAELoader` | `vae_name` |
  | 4 | `CLIPTextEncode` (positive) | `text` ← prompt |
  | 5 | `CLIPTextEncode` (negative) | `text` ← negative_prompt |
  | 6 | `EmptySD3LatentImage` | `width`, `height`, `batch_size` |
  | 7 | `KSampler` | `seed`, `steps`, `cfg`, `sampler_name: euler`, `scheduler: simple`, `denoise: 1`; `model`←1, `positive`←4, `negative`←5, `latent_image`←6 |
  | 8 | `VAEDecode` | `samples`←7, `vae`←3 |
  | 9 | `SaveImage` | `images`←8 |

  Inject params into: `4.text` (prompt), `5.text` (negative), `6.width/height`,
  `7.seed/steps/cfg`. Same graph + node mapping already proven via OpenWebUI.
- Defaults: `1024×1024`, `steps 20`, `cfg 2.5`, `euler`/`simple`, random seed.
- Perf: ~66 s/gen today (diffusion 20 GB + fp8 text encoder 8.8 GB > 24 GB VRAM → ComfyUI
  swaps the model per gen). A Lightning/distill LoRA (4–8 steps → ~10–15 s) and/or a GGUF
  text encoder is a **separate homelab follow-up**, out of scope here.

## Key design decisions (brainstorm, 2026-06-22)

1. **Config lives in a dedicated `image_config` settings doc**, NOT the `ai_config`
   registry. `ai_config` is OpenAI-compatible-only (`kind: 'openai-compatible'`, baseURL +
   API key + per-usage failover chains, fixed usage enum). ComfyUI's `/prompt`→`/history`
   →`/view` graph flow maps onto none of that. The cycle-29 **`search_config`** doc (a
   separate pluggable-provider settings row with its own store/resolve) is the precedent.
2. **Tool surface = agent + MCP** (REST deferred). `server/lib/mcp/server.ts` auto-iterates
   `agentTools` (skipping `dangerous`), so adding the tool to the registry exposes it to
   both the agent loop and the MCP server in one shot. A standalone
   `POST /api/images/generate` is YAGNI for v1.
3. **Synchronous execution**, final image only. The handler submits, polls until done,
   fetches the bytes, persists, and returns `{ id, url }` — blocking the turn (~66 s) but
   letting the agent reference the image immediately, exactly like every other `create`
   tool. Honors the agent `AbortSignal` + a hard per-image cap (180 s). **Live diffusion
   preview in chat is deferred** (its own WS-bridge sub-phase; see Deferred).
4. **Generated images skip the vision enrich pass.** The prompt is better signal than
   asking a model to re-describe our own output (and saves a vision GPU call). On create we
   seed `summary` = prompt, tag the row `['generated']` (a filterable marker — content
   search is handled by the summary embedding, so we don't LLM-derive content tags),
   compute the summary embedding into `images.embedding`, and mark `enrich_status = 'done'`,
   so the image is searchable immediately. **No migration** — every field already exists on
   `images`; generation params (seed/steps/cfg) are returned in the tool result rather than
   stored on the row (a `generation jsonb` column is a documented future option, not v1).

## Architecture

Small, single-purpose modules, communicating through narrow interfaces:

### `server/lib/imagegen/types.ts`
Contracts: `ImageGenConfig` (persisted shape), `GenerateParams` (tool inputs, normalized),
`GenerateResult` = `{ ok: true; buffer: Buffer; mime: string; meta: { seed, width, height, steps, cfg } } | { ok: false; error: string }`.

### `server/lib/imagegen/graph.ts` — pure, unit-tested
`buildComfyGraph(params: GenerateParams, config: ImageGenConfig): ComfyGraph`. Starts from
the 9-node template (or `config.workflowJson` when set) and injects prompt / negative /
width / height / steps / cfg / seed / batch_size into the mapped nodes. No I/O, no clock —
the **caller** supplies the resolved seed (so the function stays pure and testable). Returns
the API-format graph object ready for `POST /prompt`.

### `server/lib/imagegen/comfy.ts` — the HTTP client (never throws)
`generateImage(params: GenerateParams, opts: { signal?: AbortSignal }): Promise<GenerateResult>`:
1. resolve config; if `baseURL` missing → `{ ok:false, error: 'image generation not configured (…/settings → Image Gen)' }`.
2. resolve the seed (random when unset), build the graph via `graph.ts`.
3. `POST {baseURL}/prompt` with a generated `client_id` → `prompt_id`.
4. poll `GET {baseURL}/history/{prompt_id}` (fixed interval, e.g. 1.5 s) until `outputs`
   present or the cap/abort fires. Extract the first `SaveImage` output `{ filename, subfolder, type }`.
5. `GET {baseURL}/view?filename=…&subfolder=…&type=output` → image bytes + mime.
6. return `{ ok:true, buffer, mime, meta }`.

Bounds: respect `opts.signal` (abort mid-poll) and a hard 180 s cap. Any network / non-200 /
timeout / abort → `{ ok:false, error }` (no throw — mirrors `fetchAsMarkdown`'s usage in
`web_fetch`). A pure helper `extractOutputImage(history, promptId)` is split out for unit tests.

### `server/lib/imagegen/store.ts` + `config.ts`
Mirror `server/lib/search/store.ts`/`config.ts`: one `settings` row `key='image_config'`,
an in-process cache (`loadImageConfig`/`saveImageConfig`/`invalidateImageConfig`), and a
`defaultImageConfig()` (baseURL null, the Qwen filenames above, the default size/steps/cfg/
sampler/scheduler). `mergeImageConfig(partial)` fills gaps from defaults. No encryption
needed (ComfyUI is LAN, no API key) — but the store stays compatible if a key is added later.

### `server/services/images.ts` — pre-seeded create path
Add `createGeneratedImage(buffer, mime, { prompt })` (or extend `createImage` with
`opts: { summary?, tags?, skipEnrich? }` — implementer's call, single choke point either
way). It runs `processUpload` → `storage().put` → inserts the row with these existing
`images` columns (no migration):
- `summary = prompt`, `tags = ['generated']`, `enrichStatus = 'done'`
- `embedding = await embedOne(prompt)` (best-effort: on failure store null + `console.warn`;
  the row still persists and stays trigram-searchable on `summary`)
Then `publishChange({ resource: 'image', action: 'created', id })` (live-data convention).
Note: the `enrich-images` cron selects `enrich_status='pending'`, so `'done'` rows are
never re-picked — verify that predicate when implementing.

### `server/lib/agent/tools.ts` — the tool entry
```
{
  name: 'generate_image',
  description: 'Generate an image from a text prompt (local Qwen-Image). The result is
    saved to the gallery and is searchable. Returns the new image id(s) and URL(s).',
  kind: 'create',
  schema: {
    prompt: z.string().min(1),
    negative_prompt: z.string().optional(),
    width: z.number().int().min(256).max(2048).optional(),
    height: z.number().int().min(256).max(2048).optional(),
    steps: z.number().int().min(1).max(60).optional(),
    cfg: z.number().min(0).max(20).optional(),
    seed: z.number().int().optional(),
    n: z.number().int().min(1).max(4).optional()
  },
  handler: async (a, ctx) => {
    // for i in 1..n: generateImage(params, { signal: ctx.signal }); on ok → createGeneratedImage
    // collect { id, url }; on any failure return a clean { result: { ok:false, error }, summary }
    // undo: delete the created image(s)
  }
}
```
Not `dangerous` (LAN-internal, non-destructive, single-user — like `save_document`), so it
rides the default toolset and is auto-exposed via MCP. With `n>1`, generations run
sequentially (one GPU); each honors the per-image cap and the abort signal (abort stops the
loop). The model-visible result lists the created images; partial success (some succeed,
one fails) returns the successes plus the error.

### Settings UI
- `server/api/settings/image-config.get.ts` (returns the config; no secrets to redact today)
  + `image-config.put.ts` (validate + save + invalidate cache).
- `server/api/settings/test-image-provider.post.ts` — `GET {baseURL}/system_stats`; returns
  reachable/unreachable + the GPU/version blob, mirroring `test-provider.post.ts`.
- `app/components/settings/ImageGenTab.vue` + `app/composables/useImageConfig.ts`, wired into
  `app/pages/settings.vue` as a new tab. Fields: baseURL, unet/clip/vae filenames, default
  width/height/steps/cfg/sampler/scheduler, a "Test connection" button.

## Data flow

```
agent: generate_image(prompt, …)
  → loadImageConfig()
  → buildComfyGraph(params, config)           [pure]
  → comfy.generateImage(params, {signal})     [POST /prompt → poll /history → GET /view]
       ok? buffer
  → createGeneratedImage(buffer, mime, {prompt})
       processUpload → storage → insert(summary=prompt, tags=['generated'], enrichStatus='done', embedding)
  → publishChange('image','created',id)        [live gallery + chat]
  → return { result:{ images:[{id,url,seed}], params }, summary:'generated image (<id>)', undo }
```

## Error handling

- ComfyUI unreachable / non-200 / poll timeout / abort → `generateImage` → `{ ok:false, error }`
  → tool returns `{ result: { ok:false, error }, summary: 'image generation failed: <error>' }`.
  **No throw** (a thrown tool logs a system error in the activity log; an expected backend
  failure should not).
- No `baseURL` configured → the same clean error, pointing at `/settings → Image Gen`.
- `embedOne` failure → persist the image anyway (embedding null), `console.warn`; still
  trigram-searchable on `summary`.
- `n>1` partial failure → return the succeeded images + the error string; `undo` removes
  only what was created.

## Testing

Unit (pure / mockable, no live ComfyUI):
- `buildComfyGraph`: prompt/negative/size/steps/cfg/seed injection; defaults applied when
  params omitted; `batch_size` from `n`; `workflowJson` override path.
- `mergeImageConfig` / `defaultImageConfig`: gap-filling, baseURL-null default.
- `extractOutputImage(history, promptId)`: pulls `{filename, subfolder, type}` from a sample
  `/history` payload; returns null on missing/empty outputs.
- `generateImage` error paths (mocked fetch): unreachable, non-200, no-output timeout,
  aborted signal → all return `{ ok:false, error }`, never throw.
- tool handler: mocked `generateImage` + `createGeneratedImage` → asserts persist +
  `publishChange` + result shape + undo; failure → clean error result.

Live (post-merge, playwright / MCP, against the real rig):
- agent `generate_image("a red bicycle")` → a stored, gallery-visible, searchable image;
  size/steps/cfg/seed/negative honored; ComfyUI down → clean error, no crash;
  `/settings → Image Gen` test-connection passes.

## Acceptance criteria

- Agent (and MCP client) calls `generate_image` with a prompt → gets a stored, searchable
  image in the gallery, surfaced live.
- `width/height/steps/cfg/seed/negative_prompt/n` are honored.
- Provider config is editable in `/settings → Image Gen`; connectivity test passes.
- ComfyUI down → clean error result, no server crash, no spurious activity-log system error.
- Generated images carry the prompt as their summary and are immediately searchable without
  a vision enrich pass.

## Deferred (documented, not built)

- **Live diffusion preview in chat** — stream ComfyUI `/ws` step progress + binary latent
  preview frames into `/agent`. Needs a new agent event type (tool progress / image frame),
  a ComfyUI-WS → agent-WS bridge, a progress emitter on `ToolContext`, a preview UI
  component, and `--preview-method auto` on `comfyui.service`. Its own sub-phase.
- **`POST /api/images/generate` REST endpoint** — for non-agent / ShareX callers. MCP
  already covers programmatic access; add only if a need appears.
- **Perf (homelab-side)** — Lightning/distill LoRA + GGUF text encoder to drop ~66 s →
  ~10–15 s and keep both models resident.
- **`generation jsonb` column on `images`** — persist seed/steps/cfg/model on the row for
  reproducibility + a "generated with…" gallery affordance. v1 returns these in the tool
  result only; add the column (+ migration) if the on-row need appears.
