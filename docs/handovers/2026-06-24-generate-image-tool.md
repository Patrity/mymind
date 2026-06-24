---
title: generate_image agent tool (ComfyUI + Qwen-Image) — Cycle 36
cycle: 36
date: 2026-06-24
status: shipped + DEPLOYED to prod (master f8616e1, CD green); persistence live-validated (first gen landed in the gallery); post-ship fix f3ad2a3 deployed (inline image embed)
branch: feat/generate-image-tool (rebased onto master 298d603; subagent-driven, 8 tasks)
task: cb4cf239 (MyMind-side integration)
spec: ../superpowers/specs/2026-06-22-generate-image-tool-design.md
plan: ../superpowers/plans/2026-06-22-generate-image-tool.md
docs:
  - ../wiki/agent.md (updated: generate_image in the tool registry + "Image generation" section)
  - ../wiki/mcp.md (updated: tool table reconciled to the real 19-tool MCP surface)
problem: >
  MyMind agents could not create images — only ingest/search them. The homelab ComfyUI +
  Qwen-Image backend was deployed and verified (2026-06-19) but had no MyMind-side consumer.
shipped:
  - "**`server/lib/imagegen/` module** — `types.ts` (contracts), `graph.ts` (PURE 9-node ComfyUI API-graph builder; caller resolves seed; %PLACEHOLDER% override path), `store.ts` (DB-backed `image_config` settings doc — one `settings` row, module cache, zod validation; mirrors `lib/search/store.ts`; NOT the ai_config registry), `comfy.ts` (HTTP client: POST /prompt → poll /history → GET /view; NEVER throws — returns `{ok:false,error}`; 180s cap; honors AbortSignal)."
  - "**`server/services/images.ts` `createGeneratedImage`** (+ pure `buildGeneratedImageValues`) — persists prompt-seeded WITHOUT the vision enrich pass: `summary = prompt`, `embedding = embedOne(prompt)` (best-effort, null on failure), `tags = ['generated']`, `enrichStatus = 'done'` (so the `enrich-images` cron, which selects `pending`, never re-picks it). No migration — every column already existed. Searchable immediately via `searchImages` (lexical summary/tag + summary-vector RRF)."
  - "**`generate_image` agent tool** (`server/lib/agent/tools.ts`) — `kind:'create'`, NOT `dangerous`, so it rides the default toolset and is **auto-exposed via MCP** (`lib/mcp/server.ts` iterates non-dangerous `agentTools` — no per-tool wiring; surface is now 19 tools, asserted by `mcp-parity.test.ts`). Schema: prompt (req), negative_prompt?, width/height (256–2048), steps (1–60), cfg (0–20), seed?, n (1–4). Handler: sequential n loop (one GPU), abort-aware, **never-throws** (both `generateImage` AND the `createGeneratedImage` persist are guarded → a storage/DB blip returns a clean error, no spurious activity-log system error), partial-success keeps what was made, `undo` deletes + publishes `deleted`, per-image seed striding (`seed+i`) so n>1 with an explicit seed is distinct yet reproducible. Every create publishes `publishChange({resource:'image',action:'created',id})`."
  - "**Settings** — `GET/PUT /api/settings/image-config` + `POST /api/settings/test-image-provider` (pings ComfyUI `/system_stats`); `app/composables/useImageConfig.ts` + `app/components/settings/ImageGenTab.vue` (`/settings → Image Gen` tab: ComfyUI URL, model filenames, default size/steps/cfg/sampler/scheduler, Test connection). Loads via `onMounted` (NOT top-level await — that breaks inside a `<UTabs>` slot without Suspense)."
verified:
  - "Gates (final, post-fix): **typecheck 0 · `pnpm test` 94 files / 622 tests (593 baseline + 29 new) · `pnpm build` clean.**"
  - "Built subagent-driven: 8 tasks, fresh implementer + two-verdict task reviewer each, + an opus whole-branch review. Caught + fixed in review: (1) Task 3 never-throws hole — `loadImageConfig()` was awaited outside the try (DB-down would escape); (2) Task 8 full-suite gate caught `agent-tools.test.ts` hardcoded count (Task 5's per-file run had left the full suite RED — the classic subagent wiring gap); (3) whole-branch review — persist-throw escaping the handler (spurious activity-log error) + n>1 identical-image seed bug. All fixed + regression-tested."
  - "Unit coverage: graph (4), store (6), comfy (9), images-generated (2), generate-image-tool (8) — pure builders, never-throws paths, persist shape, tool registration/partial-success/abort/undo/persist-throw/seed-striding."
follow-ups:
  - "**Live E2E against the real rig (acceptance, not yet run)** — needs ComfyUI reachable on the LAN. In `/settings → Image Gen` set the ComfyUI URL (`http://192.168.2.25:8188`) → Test connection 200; agent `generate_image(\"a red bicycle on a beach\")` → image lands live in the gallery (~1 min), summary==prompt, searchable; size/steps/cfg/seed/negative honored; ComfyUI down → clean error, no crash, no spurious activity-log error; n:2 → two images. (See the plan's Live-verification section.)"
  - "**Deploy** — code change (Nuxt bakes at build), so a prod deploy/rebuild is required; the DB `image_config` is set in-app, no env/redeploy. Prod is native systemd in LXC 114."
  - "**Deferred (documented in spec, NOT built):** live diffusion preview in `/agent` (ComfyUI `/ws` → agent-WS bridge); `POST /api/images/generate` REST endpoint (MCP already covers programmatic access); homelab perf (Lightning/distill LoRA + GGUF text encoder → ~10–15s, drop the per-gen model swap); a `generation jsonb` column on `images` (seed/steps/cfg on-row for reproducibility — v1 returns these in the tool result only)."
  - "Kept-as-is per whole-branch triage (mirror sanctioned `lib/search/store.ts` precedent or by-spec): `parseImageConfigInput` cast, double `new Date()` in saveImageConfig, timeout overshoot ≤ pollInterval on the 180s cap, `invalidateImageConfig` exported-but-unused."
---

# generate_image agent tool (ComfyUI + Qwen-Image) — Cycle 36

## Why
MyMind agents (and MCP clients) could ingest and search images but not **create** them. The
homelab ComfyUI + Qwen-Image backend was live (2026-06-19) with no MyMind consumer. This cycle
is the MyMind-side integration only — the backend needed no work.

## What shipped
See the frontmatter `shipped` block. The seam: a small `server/lib/imagegen/` module (pure graph
builder + a never-throws ComfyUI client + a DB-backed `image_config` settings doc), a pre-seeded
`createGeneratedImage` in the images service (prompt → summary + embedding, vision enrich skipped),
and a non-dangerous `generate_image` tool that is auto-exposed via MCP. Config is edited in-app at
`/settings → Image Gen`.

## Key design decisions (from the spec)
- **`image_config` is its own settings doc, not the `ai_config` registry.** `ai_config` is
  OpenAI-compatible-only (baseURL + key + per-usage failover); ComfyUI's `/prompt`→`/history`→`/view`
  graph flow maps onto none of that. The cycle-29 `search_config` doc is the precedent.
- **Tool surface = agent + MCP** (REST deferred). Adding the tool to `agentTools` exposes it to both
  in one shot (the MCP server auto-derives from the non-dangerous registry).
- **Generated images skip the vision enrich pass.** The prompt is better signal than re-describing
  our own output: summary = prompt, embedding from prompt, tag `generated`, `enrich_status = 'done'`.
- **Synchronous, final image only** (~1 min, 180s cap, abort-aware). Live diffusion preview is its own
  deferred sub-phase.

## Gotchas for the next session
- **Never run live E2E without ComfyUI reachable** — the tool returns a clean `{ok:false,error}`
  when the backend is down (by design); that is not a failure of the tool.
- **The whole tool path is never-throws.** `generateImage` never throws; the `createGeneratedImage`
  persist is now also guarded in the handler — a thrown tool would log a spurious `error`-severity
  `activity_log` row via `withSpan`. Keep any new persist/IO inside that guard.
- **`onMounted` load in the settings tab is deliberate** — top-level `await` in a `<UTabs>` slot
  component breaks without a Suspense boundary (every existing settings tab uses `onMounted`).
- **MCP surface is auto-derived** from non-dangerous `agentTools`; `mcp-parity.test.ts` asserts the
  count (now 19). Adding/removing a non-dangerous tool requires updating `agent-tools.test.ts` +
  `mcp.md`'s table, or the full suite goes red (it did, mid-build — caught by the Task 8 gate).

## Post-ship fix — 2026-06-24 (f3ad2a3, deployed): inline image embed

**First live use surfaced two issues:** the agent generated an image (which DID persist — it
appeared in the gallery), reported success, and gave a **link** that 404'd; and it didn't show the
image inline.

**Root cause (one cause, both symptoms):** the tool handed the model only a URL with no embed
guidance, so the model wrote a markdown **link** `[..](/api/images/<id>/raw)`. The `/agent` chat
renders assistant markdown via `MdView` → `@nuxtjs/mdc`. A clicked relative `/api/...` link is
intercepted by the Nuxt **SPA router** (no client route) → the **SPA 404 page** — the Nitro endpoint
itself is fine. The image row existed all along; nothing was broken server-side.

**Fix:** `generate_image` now returns a ready-to-paste markdown **embed** per image
(`![<alt>](url)`) plus a top-level `markdown` string, and its description instructs the model to
embed inline (not link). MDC renders `![](url)` as a plain `<img src>` the browser fetches directly
with session cookies — so it **displays inline AND bypasses the router intercept**. Alt text strips
`[]`/newlines; `MdView` now caps images at `max-width:100%` so 1024px gens don't overflow the chat.
Gates: typecheck 0 / test 624 / build. (No `@nuxt/image`/`ProseImg` override → plain `<img>`,
confirmed.)

**General gotcha for future tools:** an agent tool returning a URL to an in-app (`/api/...`) resource
should hand the model an **embed** or an externally-openable URL, not rely on it writing an in-app
link — clicked relative `/api` links get SPA-router-intercepted to a 404. Embedded `<img>`/asset
fetches are not.
