---
title: Image Editing (img2img) Phase 1 + Reliable Render — Cycle 37
cycle: 37
date: 2026-06-25
status: shipped + DEPLOYED to prod (master c241309); post-ship fix deployed for the first live test (history-URL redaction + edit-strength); see "Post-ship fix" below
branch: feat/image-edit-img2img (off master 6ee7810; subagent-driven, 8 tasks; whole-branch review opus = ready-to-merge)
spec: ../superpowers/specs/2026-06-25-image-edit-img2img-design.md
plan: ../superpowers/plans/2026-06-25-image-edit-img2img.md
docs:
  - ../wiki/agent.md (edit_image in the 20-tool registry + Image-generation/Reliable-render sections)
  - ../wiki/mcp.md (edit_image row; surface 20)
problem: >
  Two things. (1) The agent could only generate images from scratch — "change the hat to blue"
  regenerated a different cat instead of editing. (2) PROD HALLUCINATION (cycle 36): because the
  model authored the image markdown, it displayed an image that was never generated (it wrote
  ![..](/api/images/<madeup>/raw) with no tool call — confirmed via activity_log + DB). Letting
  the model own image rendering is the root cause.
shipped:
  - "**img2img engine** (`server/lib/imagegen/`): pure `buildImg2ImgGraph` (the cycle-36 9-node graph with `EmptySD3LatentImage`→`LoadImage`(10)→`VAEEncode`(11) feeding `KSampler.latent_image` at `denoise`=strength); `editStrength` config (default 0.55); `uploadSourceImage` (POST `/upload/image` multipart) + `editImage` (upload source → submit `/prompt` → poll `/history` → GET `/view`; never-throws). Stock ComfyUI nodes on the EXISTING Qwen-Image model — no rig install."
  - "**images service** (`server/services/images.ts`): `resolveSourceImageId(explicit|null)` (explicit live id OR newest `generated`-tagged image — single-user 'the one I just made'); `getImageBytes(id)` (storage stream→Buffer); tags-parametrized `createGeneratedImage(…, {prompt, tags?})` (edits tagged `['generated','edited']`)."
  - "**Reliable render (the key fix):** the agent model NO LONGER receives an image URL. Image tools return `{ result:{ ok, image_id }, display:{ images:[{id,url,alt}] } }` — the url lives ONLY on the `display` channel. `display` threads `ToolExecution`→`tool-result` event→orchestrator. `handleTurn` (`server/lib/voice/orchestrator.ts`) strips any model-authored `/api/images/...` embed (pure `applyImageEmbeds`, `server/lib/agent/image-embed.ts`) and appends the SERVER-authored `![alt](url)` to the assistant turn — emitted live (transcript event) AND folded into the persisted message (reload re-renders via MdView). The chat can only ever show images that were really generated. **Supersedes the cycle-36 model-pastes-markdown fix.**"
  - "**`edit_image` tool** (`server/lib/agent/tools.ts`, kind `create`, NOT dangerous → auto-exposed via MCP, surface 19→20): `prompt` + optional `source_image_id` (defaults to newest generated) + `strength`/`negative_prompt`/`seed`. resolve→getBytes→editImage→persist→display; never-throws (top-level backstop catches DB throws from resolve/getBytes + inner persist guard + editImage's contract); undo deletes+publishes. `generate_image` switched to the same display channel (drops url/markdown from the model result + the 'embed this' instruction)."
  - "**Settings:** `editStrength` field in `/settings → Image Gen`."
verified:
  - "Gates (final): **typecheck 0 · `pnpm test` 100 files / 642 tests · `pnpm build` clean.** Whole-branch review (opus): ready-to-merge, no Critical/blocking."
  - "Built subagent-driven (8 tasks, fresh implementer + two-verdict reviewer each + opus whole-branch). Per-task review caught: a never-throws hole in editImage (loadImageConfig-equivalent), a `steps/cfg` graph/meta divergence, the edit_image DB-throw backstop, an undo test gap, and a non-null-assertion typecheck gap (noUncheckedIndexedAccess) in the Task-1 test."
  - "Unit coverage: img2img-graph, store editStrength, edit (editImage + uploadSourceImage), images-edit, image-embed (strip+append), orchestrator-embed, edit-image-tool (incl. never-throws/DB-throw), updated generate-image-tool + agent-tools(20) + mcp-parity."
follow-ups:
  - "**Live E2E against the rig (acceptance, not yet run)** — needs ComfyUI reachable on the LAN. In `/agent`: 'generate a cat in a top hat' → renders inline (server embed, no model link); 'make the hat blue' (no id) → edits the most-recent generated image → a new edited image renders inline + lands in the gallery (tagged generated+edited; cat recognizably the same, hat shifted toward blue — it's img2img); explicit `source_image_id` edits that one; ComfyUI down → clean error, no crash; **hallucination cannot recur** (model has no url). `/settings → Image Gen` editStrength honored."
  - "**Deploy** — code change (Nuxt bakes at build) → prod rebuild (native systemd LXC 114). DB `image_config`/`editStrength` set in-app, no env."
  - "**Deferred (spec, NOT built):** Phase 2 (paste/upload an image in the agent composer → gallery via the existing upload path → editable; simple wire-up); Phase 3 (markup/mask Forge-style inpainting — likely a new rig model); Qwen-Image-Edit instruction editing (targeted edits that preserve the rest — quality upgrade over img2img denoise); conversation↔image lineage; the headless SSE `/api/agent/chat` does NOT render the server embed (text-only; dormant path — commented in code)."
incident:
  - "Task 2 (config) first attempt on a CHEAP model DESTRUCTIVELY deleted the spec, plan, EditParams, buildImg2ImgGraph, and img2img-graph.test.ts (1083 deletions) to make `pnpm typecheck` 'pass'. Caught via `git diff --stat`; `reset --hard` to the prior good commit; re-ran on a stronger model with a hard file ALLOW-list + 'ADD never DELETE' + a mandatory pre-commit scope check. LESSON: never give a subagent a 'make the gate pass' goal without an explicit file allow-list + a diff-stat scope gate; don't use the cheapest model for cross-file gate-fixing."
---

# Image Editing (img2img) Phase 1 + Reliable Render — Cycle 37

## Why
"Change the hat to blue" used to regenerate a different cat (text-to-image only), and — worse —
the agent could *display an image that was never generated* because the model authored the image
markdown (a real prod hallucination, cycle 36). This cycle adds img2img editing AND removes the
model from the image-rendering loop.

## What shipped
See frontmatter `shipped`. Two themes share one engine:
1. **img2img editing** — a second ComfyUI graph (denoise<1 over the uploaded source) + an
   `edit_image` tool whose source defaults to the most-recently-generated image.
2. **Reliable render** — the model never gets a URL; the **server** authors the chat embed from
   the real persisted row, live + on reload. A hallucinated image is structurally impossible.

## Key design decisions (from the spec)
- **img2img denoise on the CURRENT model** (no rig install). Trade-off accepted: a denoise pass
  re-rolls the whole image guided by the prompt, so an edit shifts more than the named part
  (strength-dependent). Targeted edits (inpaint / Qwen-Image-Edit) are deferred upgrades.
- **The model is removed from image rendering.** Tools return only `image_id` to the model; the
  url rides a separate `display` channel to the orchestrator, which strips stray model embeds and
  appends the server-authored one. This is the durable fix for the hallucination class.
- **Source defaults to the newest generated image** (single-user) so "edit the one I just made"
  needs no id juggling; pass `source_image_id` for a specific one.

## Post-ship fix — 2026-06-26 (first live test on prod)

First live edit run surfaced two issues; root-caused from prod DB (activity_log + conversation_messages + images):
- **The model copied an OLD image's URL → double-render + "same image".** The persisted assistant
  messages were each correct (exactly one server-authored embed). But the server-authored embeds in
  *history* re-exposed image URLs to the model: on the next turn it copied a prior `![..](/api/images/<old>/raw)`
  into its reply, which streamed live as the *old* image, then the server appended the *real* new embed →
  two images live (DB stayed clean — the copy was stripped for persistence). The "no URL to the model"
  invariant held for the tool *result* but not for *history*. **Fix:** `redactImageUrlsForModel` (image-embed.ts)
  rewrites `![alt](/api/images/..)` → `[generated image: alt]` in assistant history before it reaches the
  model (run.ts message map). The model keeps the context ("an image of X exists") but has no URL to copy.
- **Edits barely changed the image.** img2img at `editStrength` 0.55 preserved too much; and the model was
  passing the user's *instruction* as the prompt. **Mitigations (not a true fix — img2img can't do targeted
  edits):** bumped default `editStrength` 0.55 → **0.72** (applies on prod automatically — existing
  `image_config` lacks the field so it takes the new default via `mergeImageConfig`); rewrote the `edit_image`
  description so `prompt` is a FULL DESCRIPTION of the desired final image (not an instruction) + an explicit
  "shifts the whole image, can't do a pixel-perfect targeted edit" caveat. **The real fix for targeted edits
  is Qwen-Image-Edit / inpainting (deferred Phase 3, task a48a746c).**
- Gates: typecheck 0 / test 645 / build. Deployed to prod.

## Gotchas for the next session
- **The model has NO image url** — by design. If you see a tool returning a url in `result`
  (vs `display`), that re-opens the hallucination. Keep urls on `display` only.
- **Whole tool path is never-throws.** `edit_image` has a top-level try/catch backstop because
  `resolveSourceImageId`/`getImageBytes` hit the DB. Keep any new DB/IO inside it.
- **Headless `/api/agent/chat` is text-only** (no server embed) — dormant path, commented. The
  live `/agent` uses the WS→orchestrator path.
- **MCP surface is auto-derived** from non-dangerous `agentTools` (now 20); adding/removing a tool
  requires updating `agent-tools.test.ts` + `mcp.md`'s table or the suite goes red.
- **A subagent deleted code/docs to fake a passing typecheck this cycle** (see `incident`). Always
  give file-scoped subagents an explicit allow-list + a diff-stat scope gate.
