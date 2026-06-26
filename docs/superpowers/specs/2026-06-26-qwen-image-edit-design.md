---
title: Qwen-Image-Edit-2509 — instruction-based image editing (replaces img2img)
status: approved
date: 2026-06-26
cycle: 38
related:
  - docs/superpowers/specs/2026-06-25-image-edit-img2img-design.md (cycle 37 — the img2img edit this replaces + the reliable-render fix this keeps)
  - docs/handovers/2026-06-25-image-edit-img2img.md
  - homelab task "ComfyUI + Qwen-Image image generation on GPU 0" (Qwen-Image-Edit-2509 installed + verified 2026-06-26)
---

# Qwen-Image-Edit-2509 — instruction-based image editing

Replace `edit_image`'s backend (cycle-37 img2img denoise) with **Qwen-Image-Edit-2509**, an
instruction-based image editor. img2img re-renders the whole image and cannot do a targeted edit
("change the hat to blue" shifted the whole cat and barely changed the hat). Qwen-Image-Edit takes
the source image + an instruction and edits *that* while preserving the subject — verified live on
the rig (red baseball cap → blue cowboy hat, same face/background, ~14 s warm). Only the ComfyUI
graph + edit model change; `generate_image` (base Qwen-Image text-to-image) and the cycle-37
**reliable-render** fix (model gets no URL; server authors the chat embed) are unchanged.

## Backend (live — installed + verified 2026-06-26 on rig 192.168.2.25:8188)

ComfyUI 0.25.0 already had the native edit nodes. Files under `~/ComfyUI/models/`:
- `diffusion_models/qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors` (20 GB) — **the Lightning
  4-step LoRA baked into the fp8 weights** (the merged model). **This is the default.** Applying the
  bf16 LoRA at runtime dequantizes fp8 layers and OOMs the 24 GB card; the merged model loads like
  the base model and fits with ~5 GB headroom. ~30 s cold / **~14 s warm**.
- `diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors` (20.4 GB) — unmerged base edit model
  for the 20-step **quality** path (~124 s).
- Reused (unchanged): `qwen_2.5_vl_7b_fp8_scaled.safetensors` (text encoder), `qwen_image_vae.safetensors` (VAE).

### The edit graph (API format) — confirmed working

Loaders + reused encoder/VAE:

| node | class_type | inputs |
|---|---|---|
| 37 | `UNETLoader` | `unet_name` (the merged or unmerged edit model), `weight_dtype: "default"` |
| 38 | `CLIPLoader` | `clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors"`, `type: "qwen_image"` |
| 39 | `VAELoader` | `vae_name: "qwen_image_vae.safetensors"` |

Model chain (the **merged** model needs NO LoRA loader — it's baked in):

| node | class_type | inputs |
|---|---|---|
| 66 | `ModelSamplingAuraFlow` | `model: ["37",0]`, `shift: 3.0` |
| 75 | `CFGNorm` | `model: ["66",0]`, `strength: 1.0` |

Source image chain:

| node | class_type | inputs |
|---|---|---|
| 78 | `LoadImage` | `image: "<uploaded filename>"` |
| 117 | `FluxKontextImageScale` | `image: ["78",0]` (snaps to the model's optimal resolution — no manual width/height) |
| 88 | `VAEEncode` | `pixels: ["117",0]`, `vae: ["39",0]` |

Conditioning + sample:

| node | class_type | inputs |
|---|---|---|
| 111 | `TextEncodeQwenImageEditPlus` (positive) | `clip: ["38",0]`, `vae: ["39",0]`, `image1: ["117",0]`, `prompt: "<instruction>"` |
| 110 | `TextEncodeQwenImageEditPlus` (negative) | `clip: ["38",0]`, `vae: ["39",0]`, `image1: ["117",0]`, `prompt: ""` |
| 3 | `KSampler` | `model: ["75",0]`, `positive: ["111",0]`, `negative: ["110",0]`, `latent_image: ["88",0]`, `seed`, `steps`, `cfg`, `sampler_name: "euler"`, `scheduler: "simple"`, `denoise: 1.0` |
| 8 | `VAEDecode` | `samples: ["3",0]`, `vae: ["39",0]` |
| 9 | `SaveImage` | `images: ["8",0]`, `filename_prefix: "mymind-edit"` |

Single-image edit (`image1` only — `image2`/`image3` multi-reference is YAGNI for v1). The
upload→`/prompt`→poll `/history`→GET `/view` flow is **identical** to cycle 37, so `uploadSourceImage`
is reused unchanged.

### Settings

| Path | `unet_name` | steps | cfg | sampler/scheduler | shift |
|---|---|---|---|---|---|
| **Fast (default)** | `…_lightning4.safetensors` (merged) | 4 | 1.0 | euler / simple | 3.0 |
| **Quality** (`quality: true`) | `…fp8_e4m3fn.safetensors` (unmerged) | 20 | 2.5 | euler / simple | 3.0 |

## Design

### What is removed (img2img edit — cycle 37)

img2img produced the bad edits, so it goes (user-approved):
- `buildImg2ImgGraph` + `server/lib/imagegen/img2img-graph.test.ts`.
- `editStrength` from `ImageGenConfig` / `defaultImageConfig` / `imageConfigInputSchema` / the store
  test / the `/settings → Image Gen` field.
- The `strength` param on the `edit_image` tool.
- `editImage`'s img2img wiring (the function name stays; its body switches to the edit graph).

### Config (extend `image_config`)

Add edit-model fields (reuse `clipName`/`vaeName`):
- `editUnetName: string` (default `qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors`)
- `editSteps: number` (default 4), `editCfg: number` (default 1.0)
- `editUnetQualityName: string` (default `qwen_image_edit_2509_fp8_e4m3fn.safetensors`)
- `editStepsQuality: number` (default 20), `editCfgQuality: number` (default 2.5)
- `editShift: number` (default 3.0)

The `/settings → Image Gen` tab gains these fields (replacing the removed `editStrength`).

### Graph builder

`buildQwenEditGraph(params: EditParams, config: ImageGenConfig, sourceFilename: string, opts: { quality?: boolean }): ComfyGraph` (pure) — produces the table above. `quality` selects
`editUnetName`/`editSteps`/`editCfg` vs the `*Quality` trio. `EditParams` drops `strength`, keeps
`prompt` (the instruction), `negativePrompt?` (default ''), `seed`.

### Client

`editImage(params, opts)` (comfy.ts) — unchanged signature except `params` drops `strength` and
`opts` gains `quality?: boolean`; it uploads the source (existing `uploadSourceImage`), builds the
edit graph, submits/polls/fetches (existing flow). Never-throws. No width/height in `meta` from the
source (FluxKontextImageScale decides) — `meta` carries `seed` (+ steps/cfg used).

### Tool

`edit_image` — `prompt` is the **instruction** again (revert the cycle-37-fix "full description"
wording: "describe the change, e.g. 'change the hat to a blue cowboy hat'"). Schema: `prompt` (req),
`source_image_id?` (default = newest generated, unchanged), `negative_prompt?`, `seed?`,
**`quality?: boolean`** (default false → fast). Drops `strength`. Persist + reliable-render
(`display` channel) unchanged; result tagged `['generated','edited']`. Never-throws + undo unchanged.

## Data flow

```
user: "change the hat to a blue cowboy hat"
edit_image(prompt:"change the hat to a blue cowboy hat")        [no id -> newest generated]
  -> resolveSourceImageId -> getImageBytes
  -> uploadSourceImage(bytes) -> uploaded filename
  -> buildQwenEditGraph(params, config, filename, {quality:false})   [merged 4-step, shift 3, cfg 1]
  -> editImage: POST /prompt -> poll /history -> GET /view -> buffer
  -> createGeneratedImage(buffer, mime, {prompt, tags:['generated','edited']})
  -> publishChange('image','created',id)
  -> result {ok,image_id} + display{images:[{id,url,alt}]}        [model gets NO url]
  -> server authors the chat embed (cycle-37 reliable render)
```

## Error handling

Same as cycle 37: ComfyUI unreachable / upload fail / poll timeout / abort / source-not-found /
persist throw → clean `{ ok:false, error }`, never throw. Edit model unconfigured (no `editUnetName`
or no `baseURL`) → clean error pointing at `/settings → Image Gen`.

## Testing

Unit (pure / mockable):
- `buildQwenEditGraph`: node wiring (37→66→75→3 model chain; 78→117→88 source chain; 111/110 encode
  with image1←117 + prompt; KSampler steps/cfg from config); `quality:true` selects the unmerged
  unet + 20 steps + cfg 2.5; `quality:false` selects merged + 4 + 1.0.
- `editImage` error paths (mocked `$fetch`): unreachable / upload fail / timeout / abort → `{ok:false}`.
- `edit_image` tool (mocked `editImage`+`createGeneratedImage`): result has `image_id` + `display`
  (no url to model); `quality` forwarded; persist tagged `generated,edited`; undo; clean errors.
- config: `editUnetName`/`editShift` etc. defaults + validation.

Live (post-merge, against the rig): `generate_image("a cat in a top hat")` then
`edit_image("change the hat to a blue cowboy hat")` → the hat changes, subject preserved, ~14 s,
renders inline (cycle-37 embed); `quality:true` → the 20-step path; ComfyUI down → clean error.

## Acceptance criteria

- "Generate X, then change Y" produces a **targeted instruction edit** (subject preserved), inline in
  chat + in the gallery (tagged `generated,edited`), at the merged 4-step speed by default.
- `quality:true` runs the 20-step unmerged path.
- The model never receives an image URL (cycle-37 invariant intact); a hallucinated image can't render.
- img2img (`buildImg2ImgGraph` / `editStrength` / the `strength` param) is gone; nothing references it.
- ComfyUI down / source missing → clean error, no crash.

## Deferred (documented, not built)

- **Multi-image reference** (`image2`/`image3` on `TextEncodeQwenImageEditPlus`) — compose/blend
  multiple sources; YAGNI for v1.
- **Phase 2** — paste/upload an image in the agent composer → gallery → editable (cycle-37 deferred,
  unchanged; now even more useful with real editing).
- A per-call resolution/aspect override (FluxKontextImageScale auto-picks for v1).
