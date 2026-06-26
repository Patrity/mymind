---
title: Image Editing (img2img) — Phase 1 + Reliable Image Rendering
status: approved
date: 2026-06-25
cycle: 37
related:
  - docs/superpowers/specs/2026-06-22-generate-image-tool-design.md (cycle 36 — generate_image)
  - docs/handovers/2026-06-24-generate-image-tool.md (incl. the post-ship inline-embed fix)
  - homelab task "ComfyUI + Qwen-Image image generation on GPU 0" (backend, live)
  - docs/wiki/agent.md (agent tool surface)
---

# Image Editing (img2img) — Phase 1 + Reliable Image Rendering

Give MyMind agents the ability to **edit/iterate on an image** ("change the top hat to blue")
via ComfyUI img2img on the already-installed Qwen-Image model, and fix the **reliability bug**
that lets the model display images that were never generated. This is **Phase 1** of a 3-phase
image-editing capability; it ships the shared engine + the most common case (iterate on the
image you just made), and folds in the rendering fix that "iterate on previous" depends on.

## Background — the bug this also fixes

The cycle-36 `generate_image` tool returns a URL and relies on the **model** to embed it as
markdown (`![prompt](url)`). In prod (2026-06-25) the model **hallucinated** an image: it wrote
`![a cat wearing a blue top hat](/api/images/961d018a-…/raw)` for an id that was **never
generated** (no tool call fired; the activity log shows no `generate_image` call for that turn).
The image was "broken" in chat and absent from the gallery because it never existed. Root cause:
**letting the model author the image embed lets it display images that don't exist.** Phase 1
removes the model from the rendering loop.

## Phased roadmap (this spec = Phase 1)

| Phase | Scope | Status |
|---|---|---|
| **1** | Reliable rendering + img2img `edit_image` (source by image id, defaults to last generated) | **this spec** |
| 2 | Paste/upload an image in the agent chat → upload to gallery (existing path) → editable | later (simple wire-up) |
| 3 | Markup/mask (Forge-style) inpainting | later (likely needs an inpaint model on the rig) |

Future upgrade (any phase): instruction-edit via **Qwen-Image-Edit** for targeted edits — out
of scope; Phase 1 uses **img2img denoise** on the current model (a denoise pass re-rolls the
whole image guided by the prompt, so an edit shifts the rest of the image somewhat,
strength-dependent — an accepted trade-off).

## Backend (live — no new install)

ComfyUI on the AI rig `http://192.168.2.25:8188` already runs Qwen-Image fp8 (UNET/CLIP/VAE per
the cycle-36 spec). img2img needs only **stock ComfyUI nodes** + the **`/upload/image`** endpoint
— no new model:

- `POST {base}/upload/image` (multipart `image=@file`) → `{ name, subfolder, type }`; the
  uploaded file is then referenceable by `LoadImage`.
- img2img graph (API format), built from the source image + params:

  | # | node | key params |
  |---|---|---|
  | 1 | `UNETLoader` | `unet_name` |
  | 2 | `CLIPLoader` | `clip_name`, `type: "qwen_image"` |
  | 3 | `VAELoader` | `vae_name` |
  | 4 | `CLIPTextEncode` (positive) | `text` ← prompt |
  | 5 | `CLIPTextEncode` (negative) | `text` ← negative |
  | 10 | `LoadImage` | `image` ← uploaded filename |
  | 11 | `VAEEncode` | `pixels` ← `LoadImage`, `vae` ← `VAELoader` |
  | 7 | `KSampler` | `seed`, `steps`, `cfg`, `sampler_name`, `scheduler`, **`denoise` = strength**; `model`←1, `positive`←4, `negative`←5, **`latent_image`←`VAEEncode`** |
  | 8 | `VAEDecode` | `samples`←7, `vae`←3 |
  | 9 | `SaveImage` | `images`←8 |

  The only structural change from the text-to-image graph: node 6 (`EmptySD3LatentImage`) is
  replaced by `LoadImage` → `VAEEncode` feeding the KSampler's `latent_image`, and `denoise` is
  the strength (< 1) instead of 1.

## Design

### Part 1 — Reliable image rendering (server owns the embed)

The model is removed from the image-rendering loop:

1. **The tool's result to the model carries NO URL.** `generate_image`/`edit_image` return to the
   model only `{ ok: true, image_id, summary }` (no `url`, no `markdown`) plus the instruction
   (in the tool description) that the image is shown to the user automatically and the model must
   NOT write an image link. With no URL, the model cannot fabricate a working-looking embed.
2. **The server authors the embed.** When an image tool succeeds, the server appends the correct
   `![<prompt>](<real-url>)` — built from the actually-persisted row — to that assistant turn,
   both in the live stream (so it renders immediately) and in the persisted
   `conversation_messages.content` (so it survives reload via `MdView`). One source of truth: the
   real row.
3. **Safety net.** Before persisting an assistant message, strip any stray model-authored
   `![..](/api/images/…)` / `[..](/api/images/…/raw)` embeds (in case a model writes one anyway),
   then append the server-authored embeds. So a hallucinated link can never render.

Net effect: the chat can only ever display images that were actually generated/edited, the
display is independent of model behavior, and it is correct on reload.

> This **supersedes the cycle-36 post-ship embed fix** (where `generate_image` returned a `markdown`
> field for the model to paste). `generate_image` is changed the same way as `edit_image`: its
> result to the model drops `url`/`markdown` (keeps `image_id`), its description drops the
> "embed this" instruction, and the server authors its embed too. The `MdView` `max-width` image
> CSS from that fix stays.

> Implementation seam: the agent run (`server/lib/agent/run.ts` + the WS/transport that persists
> the assistant message) collects the image ids created during the turn (from the real tool
> results via the existing `tool-result` event path in `server/lib/agent/ai-tools.ts`) and owns
> the embed. The `image` live event already fires on create (gallery stays live regardless).

### Part 2 — Source-image referencing ("iterate on previous")

`edit_image` takes an **optional** `source_image_id`:

- **Provided** → edit that specific image (must be a live image row; else clean error).
- **Omitted** → default to the **most recently generated image** — single-user, so
  `SELECT id FROM images WHERE 'generated' = ANY(tags) AND deleted_at IS NULL ORDER BY created_at
  DESC LIMIT 1`. Covers "generate, then immediately edit it" with no id juggling. If there is no
  prior generated image → clean error ("nothing to edit; generate an image first").

A pure helper `resolveSourceImageId(explicitId | null)` encapsulates this so it is unit-testable.

### Part 3 — img2img edit engine

New, mirroring the cycle-36 imagegen module:

- **`server/lib/imagegen/graph.ts`** gains `buildImg2ImgGraph(params, config, uploadedFilename)`
  (pure) — the table above, injecting prompt/negative/steps/cfg/seed + `denoise` = strength +
  the uploaded source filename. (Or a sibling `img2img.ts` if cleaner — implementer's call.)
- **`server/lib/imagegen/comfy.ts`** gains `uploadSourceImage(bytes, mime, opts)` (POST
  `/upload/image`, never-throws) and `editImage(params, opts)` — fetch path mirrors
  `generateImage` (submit → poll `/history` → GET `/view`), preceded by the source upload. Returns
  `{ ok, buffer, mime, meta }` | `{ ok:false, error }`; **never throws**.
- **`server/services/images.ts`**: the source bytes come from `storage().get(row.storageKey)` for
  a MyMind image id. The result is persisted via the existing `createGeneratedImage` path with
  `summary` = the edit prompt and `tags` = `['generated','edited']` (so edits are filterable but
  still searchable + skip vision enrich, same as generations).
- **`server/lib/agent/tools.ts`**: a new `edit_image` tool — `kind: 'create'`, NOT `dangerous`
  (rides the default toolset + MCP, like `generate_image`):
  ```
  schema: {
    prompt: string (the change to make),
    source_image_id?: string (defaults to the last generated image),
    strength?: number 0–1 (denoise; default from config editStrength ~0.55),
    negative_prompt?: string,
    seed?: int
  }
  ```
  Handler: `resolveSourceImageId` → load source bytes → `editImage(...)` → `createGeneratedImage`
  → return `{ ok:true, image_id, summary }` to the model (NO url; server renders). Same
  never-throws + `undo` (delete created image) discipline as `generate_image`.
- **`image_config`**: add `editStrength` (default 0.55) to the settings doc + the `/settings →
  Image Gen` tab.

## Data flow

```
user: "change the hat to blue"
agent: edit_image(prompt:"change the hat to blue")           [no source_image_id]
  → resolveSourceImageId(null) → newest 'generated' image id
  → storage().get(sourceRow.storageKey) → source bytes
  → comfy.uploadSourceImage(bytes) → uploaded filename
  → buildImg2ImgGraph(params, config, filename)              [pure; denoise=strength]
  → comfy.editImage → submit /prompt → poll /history → GET /view → buffer
  → createGeneratedImage(buffer, mime, { prompt, tags:['generated','edited'] })
  → publishChange('image','created',id)                      [live gallery]
  → tool result to MODEL: { ok:true, image_id }              [NO url]
  → SERVER appends ![change the hat to blue](/api/images/<id>/raw) to the assistant turn
  → chat renders the real edited image inline (live + on reload)
```

## Error handling

- ComfyUI unreachable / non-200 / upload fails / poll timeout / abort → `editImage` → `{ ok:false,
  error }` → tool returns `{ ok:false, error }` to the model (no throw, no spurious activity-log
  system error — same convention as `generate_image`).
- `source_image_id` not found / no prior generated image → clean `{ ok:false, error }` with a
  helpful message.
- Persist (`createGeneratedImage`) throw → guarded → clean error (same as cycle-36's post-ship fix).
- `editStrength` clamped to (0,1].

## Testing

Unit (pure / mockable, no live ComfyUI):
- `buildImg2ImgGraph`: source filename + prompt/negative/steps/cfg/seed/denoise injection;
  KSampler `latent_image` wired to `VAEEncode`; defaults applied.
- `resolveSourceImageId`: explicit id passthrough; omitted → newest generated; none → error.
- `uploadSourceImage` / `editImage` error paths (mocked `$fetch`): unreachable, upload failure,
  no-output timeout, abort → all `{ ok:false, error }`, never throw.
- The **embed-injection** helper (Part 1): strips model-authored `/api/images/...` embeds and
  appends the server embed for the real ids — pure string helper, unit-tested.
- `edit_image` tool handler (mocked `editImage` + `createGeneratedImage`): persist + result shape
  (id, no url) + undo; failure → clean error.

Live (post-merge, against the real rig): generate an image, then `edit_image("change the hat to
blue")` with no id → a new edited image appears live in the gallery + inline in chat; the model's
reply contains no fabricated link; ComfyUI down → clean error, no crash; explicit
`source_image_id` edits that image; a hallucinated/fabricated embed is impossible (model has no
url).

## Acceptance criteria

- "Generate X, then change Y" produces a **real edited image** shown inline in chat (from the
  server-authored embed) and present in the gallery; the edit is img2img on the source.
- The model **cannot** display an image that was not generated (no url given to the model; stray
  embeds stripped). The cycle-36 hallucination bug cannot recur.
- `source_image_id` omitted → edits the most recent generated image; provided → edits that one.
- `strength` controls how far the edit departs from the source; ComfyUI down → clean error.
- Editing rides the default toolset + MCP; no new rig model installed.

## Deferred (documented, not built)

- **Phase 2** — paste/upload an image in the agent composer (→ gallery via the existing upload
  path → editable). Simple wire-up; its own change.
- **Phase 3** — markup/mask (Forge-style) inpainting (mask UI + inpaint workflow; likely a new
  rig model).
- **Qwen-Image-Edit** instruction editing (targeted edits that preserve the rest of the image) —
  a quality upgrade over img2img denoise; needs the model on the rig.
- **Conversation↔image lineage** — precise "edit the 2nd image from 3 turns ago" beyond
  newest-generated; not needed for the common case.
- **`generation`/`edit` provenance column** on `images` (source_image_id, strength, seed) — the
  cycle-36 deferred `generation jsonb` idea, extended to edits.
