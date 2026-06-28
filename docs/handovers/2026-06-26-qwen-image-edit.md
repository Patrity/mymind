---
title: Qwen-Image-Edit-2509 — instruction editing (replaces img2img) — Cycle 38
cycle: 38
date: 2026-06-26
status: shipped — gates green (typecheck 0 / test 647 / build); NOT yet deployed; live rig E2E pending
branch: feat/qwen-image-edit (off master 379c8b4; subagent-driven, 7 tasks; whole-branch review opus = ready-to-merge)
spec: ../superpowers/specs/2026-06-26-qwen-image-edit-design.md
plan: ../superpowers/plans/2026-06-26-qwen-image-edit.md
docs:
  - ../wiki/agent.md (edit_image → Qwen-Image-Edit instruction editing; img2img removed)
  - ../wiki/mcp.md (edit_image description; surface stays 20)
problem: >
  Cycle-37 img2img edits barely changed the image ("change the hat to blue" shifted the whole cat,
  hat unchanged) — img2img denoise re-renders the whole image and can't do a targeted edit. The fix
  is a different MODEL: Qwen-Image-Edit-2509, an instruction-based editor (verified on the rig
  2026-06-26: red baseball cap → blue cowboy hat, subject preserved, ~14 s).
shipped:
  - "**`buildQwenEditGraph`** (`server/lib/imagegen/graph.ts`, pure) — the verified 2509 ComfyUI graph: `UNETLoader(37) → ModelSamplingAuraFlow(66, shift) → CFGNorm(75) → KSampler(3)`; `LoadImage(78) → FluxKontextImageScale(117) → VAEEncode(88)`; two `TextEncodeQwenImageEditPlus` (111 positive=instruction, 110 negative=''), each fed `clip(38)`/`vae(39)`/`image1(117)`. The scaled source feeds BOTH the latent (VAEEncode) and the conditioning (image1). `denoise 1.0`, `sampler/scheduler` from config."
  - "**Edit-model config** (`image_config`) — fast (default) merged `qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors` (4 steps, cfg 1.0) + quality unmerged `qwen_image_edit_2509_fp8_e4m3fn.safetensors` (20 steps, cfg 2.5) + `editShift` 3.0. Reuses the existing `clipName`/`vaeName`. `/settings → Image Gen` gained these fields."
  - "**`editImage`** (comfy.ts) repointed at `buildQwenEditGraph` with a `quality` opt; same `uploadSourceImage`→`/prompt`→poll `/history`→`/view` flow (FluxKontextImageScale auto-picks resolution — no width/height juggling). Never-throws."
  - "**`edit_image` tool** — `prompt` is an INSTRUCTION again (\"change the hat to a blue cowboy hat\" — edits the named part, preserves the rest); new `quality?: boolean` (default fast). Dropped `strength`. The cycle-37 **reliable-render** path is intact: the model gets NO url (result = `{ok, image_id}`; url only on the `display` channel; server authors the embed; history urls redacted). Tags `['generated','edited']`; undo; source defaults to newest generated."
  - "**Removed** the img2img engine: `buildImg2ImgGraph`, `img2img-graph.test.ts`, `editStrength` (config/schema/UI/tests), the transient `strength?` param — all in one isolated grep-verified pass after migration. `generate_image` (base Qwen-Image t2i) unchanged."
verified:
  - "Gates: **typecheck 0 · `pnpm test` 100 files / 647 tests · `pnpm build` clean.** Whole-branch review (opus): ready-to-merge, no Critical/Important — graph edge-exact, fast/quality never mixes, no-URL-to-model invariant intact, removal complete (no dead refs), config back-compat via `mergeImageConfig` (a pre-cycle-38 prod config gets the new fields filled), never-throws end-to-end."
  - "Built subagent-driven (7 tasks, sonnet implementers + two-verdict reviews + opus whole-branch). Ordering was additive-first (T1–5 keep typecheck green) with the img2img removal isolated to T6 — deliberately, to avoid cycle-37's delete-to-pass-a-gate failure. It worked: T6 removed exactly the targets, grep-clean, no collateral."
  - "Per-task review caught: an ordering flaw (dropping `strength` from editImage's type broke the tools.ts call — fixed by keeping `strength?` transient through T3, removing it in T6) and fast-path test gaps (added steps/cfg assertions). Final cleanup dropped the now-dead `EditParams.steps?/cfg?` so the `quality` flag is the single source of truth."
follow-ups:
  - "**Live rig E2E (acceptance, not yet run)** — needs ComfyUI + the 2509 models reachable. In `/agent`: generate a cat in a top hat → 'change the hat to a blue cowboy hat' (no id) → the hat actually becomes a blue cowboy hat with the SAME cat/background, ~14 s, one image inline (no duplicate/old-image), in the gallery tagged generated,edited. Ask for a 'high quality' edit → the 20-step path. ComfyUI down → clean error. NOTE: the unit suite proves graph SHAPE, not that the live 2509 nodes accept this exact API graph — the live run is the real proof."
  - "**Deploy** — push master → CD rebuild (native systemd LXC 114). The edit-model defaults apply automatically (existing prod `image_config` lacks the fields → `mergeImageConfig` fills them); no env change. To point at different model filenames, edit `/settings → Image Gen`."
  - "**Deferred (spec):** multi-image reference (`image2`/`image3` on TextEncodeQwenImageEditPlus); Phase 2 (paste/upload an image in the agent composer → gallery → editable; even more useful now); a per-call resolution/aspect override."
---

# Qwen-Image-Edit-2509 — instruction editing — Cycle 38

## Why
img2img (cycle 37) couldn't do targeted edits. Qwen-Image-Edit-2509 is an instruction-based editor —
the right tool — and reuses the rig's existing Qwen text encoder + VAE, so only one new model
(installed + verified 2026-06-26). This cycle swaps `edit_image`'s backend to it and removes img2img.

## What shipped
See frontmatter `shipped`. The verified 2509 graph reproduced in `buildQwenEditGraph`; a fast-merged
default + a `quality` toggle; `edit_image` back to instruction prompts; img2img removed. The cycle-37
reliable-render path (no url to the model; server authors the embed; history urls redacted) is
unchanged.

## Key decisions
- **A new model, not a tuning of img2img** — img2img re-renders the whole image; only an
  instruction-edit model can change the named part. Qwen-Image-Edit-2509 reuses the existing
  encoder/VAE, so it was a single rig install + this MyMind integration.
- **Merged lightning model is the default** — applying the 4-step LoRA at runtime OOMs the 24 GB
  card (fp8 dequant spike); the homelab baked the LoRA into the fp8 weights, so it loads like a plain
  model (~14 s warm). The unmerged 20-step model is the `quality` path.
- **img2img removed, not kept as fallback** (user-approved) — it produced the bad edits; keeping it
  would be a confusing dead path.

## Gotchas for the next session
- **The live rig E2E is the real proof** — the unit tests assert the graph SHAPE, not that the live
  2509 ComfyUI nodes accept this exact API graph. Run a real edit before calling it done.
- **The model still gets NO image url** (cycle-37 invariant) — keep urls on the `display` channel
  only; never in the tool `result`, and history urls stay redacted (see image-embed.ts).
- **Edit config is separate from generate config** — `edit_image` uses `editUnetName`/`editSteps`/
  `editCfg` (+ the `*Quality` trio + `editShift`); `generate_image` uses `unetName`/`steps`/`cfg`.
- **The `quality` flag is the single source of truth for edit steps/cfg** — `EditParams` no longer
  carries `steps`/`cfg` (there's no per-call override; set the config in `/settings`).
- **Additive-first + isolated-removal is the pattern that worked** — adding the new engine first
  (typecheck green throughout) then removing the old one in one grep-verified pass avoided the
  cross-file red-typecheck window that tempted a destructive subagent in cycle 37.
