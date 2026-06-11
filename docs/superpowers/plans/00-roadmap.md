---
title: MyMind Master Roadmap
status: active
updated: 2026-06-10
read_first: true
---

# MyMind — Master Roadmap

The cross-cycle source of truth. **Read this first every session**, then the newest handover in [`../../handovers/`](../../handovers/).

MyMind is one modular Nuxt 4 service (web app + MCP server + HTTP endpoints) that consolidates Tony's document management, tasks/projects, image hosting, quick capture, memory, and clipboard into a single self-hosted "second brain," running in the homelab (Proxmox + Docker) and exposed to the internet for sharing.

It is built as a sequence of **sub-project cycles**. Each cycle: `brainstorm → spec → plan → build → handover → update roadmap + wiki`.

## Locked global decisions

These hold across all cycles. Change them here (with a dated note) if they ever change.

| Decision | Choice |
|---|---|
| Architecture | One Nuxt 4 service. Web + Nitro HTTP + MCP from the same app. No separate backends. |
| Memory system | **Reimplemented in Nitro/TS** (porting the proven Python `bridget-services/memory` design, not its code). |
| LLM/model access | **DB-backed registry (2026-06-10, cycle 12 — superseded env-only config).** Providers/models + per-usage failover chains live in one JSONB `ai_config` doc, edited in-app at `/settings`; keys encrypted at rest. Usages: `reasoning`, `bulk`, `embeddings`, `vision`/OCR, `stt`, `tts`, `rerank`. Providers are `anthropic` or `openai-compatible`. Local default (AI rig `192.168.2.25`), hosted (Haiku / GPT / Gemini Flash) for hard reasoning. Swapping a model = UI change, never code, never an env redeploy. The old `AI_*` env vars are now one-time onboarding import seeds only. |
| Embeddings | `qwen3-embedding-4b`, **2560-dim**, stored as `halfvec(2560)` with HNSW cosine. TEI fronted to expose OpenAI `/v1/embeddings`. |
| Doc organization | **Hybrid**: canonical path tree (incl. `/input` staging) for the human browser, plus first-class queryable columns (`project`, `domain`, `type`, `tags`, `topic` ltree) promoted out of frontmatter. |
| Search | Trigram (keyword) from cycle 1; semantic + RRF fusion added in the enrichment cycle. |
| Auth | better-auth. Two surfaces: session (web) + bearer API tokens (machine clients: ShareX, CC/Hermes hooks, MCP). |
| Storage | Local-disk/S3 abstraction (ported from `copipasta`). |
| Backups | Handled **out-of-band** (nightly DB dump to an external service). Not an in-app concern. In-app markdown export is an optional future feature, not core. |
| AI safety | Every AI mutation (tags, frontmatter, filing, memories) is reviewable/reversible via a `reviewed_at`-style surface. Auto-review high-confidence items; only low-confidence needs human review (2026-06-03). |
| Render mode (2026-06-03) | **SPA** (`ssr: false`) for the authed app; **SSR/prerender** only for public `/share/**` + `/i/**` via routeRules. Decided after the first-pass `/documents` pre-login flash. |
| Reranker (2026-06-03) | `Qwen3-Reranker-0.6B` at `192.168.2.25:8883` available for relevance scoring (memory/doc search). |

## Cycle status

Legend: `planned` → `spec'd` → `in-progress` → `shipped`

| # | Cycle | Status | Spec | Plan | Handover |
|---|---|---|---|---|---|
| 1 | **Foundation + Content Spine** — app shell, dual auth, Drizzle/pg/pgvector, storage, document model, path-tree browser + CodeMirror/MDC editor (edit/preview/split), manual frontmatter, trigram search, public-slug sharing, env provider scaffold. Ships a manual-but-complete doc manager. | ✅ shipped | [spec](../specs/2026-06-02-foundation-content-spine.md) | [plan](2026-06-02-foundation-content-spine.md) | [handover](../../handovers/2026-06-03-foundation-content-spine.md) |
| 2 | **AI Enrichment + Notification Queue** — embedding worker (fills `halfvec`), semantic + RRF search, `/input` auto-tag/sort/frontmatter, AI-action review surface, human-needed notification queue. (+ login page fast-follow) | ✅ shipped | [spec](../specs/2026-06-03-ai-enrichment.md) | [plan](2026-06-03-ai-enrichment.md) | [handover](../../handovers/2026-06-03-ai-enrichment.md) |
| 3 | **Quick Capture + Image Hosting/Gallery** — quick note/todo/idea capture, image/gif/video upload (ShareX/CleanShot endpoints), sharp→webp/webm, OCR tags (confirmed + recommended), gallery, public/private. | ✅ shipped | [spec](../specs/2026-06-03-capture-images.md) | [plan](2026-06-03-capture-images.md) | [handover](../../handovers/2026-06-03-capture-images.md) |
| 4 | **Tasks + Projects (Kanban)** — projects (name/desc/active), kanban (todo/in-progress/completed/blocked), task fields + audit log, doc↔project↔domain relations. | ✅ shipped | [spec](../specs/2026-06-03-tasks-projects.md) | [plan](2026-06-03-tasks-projects.md) | [handover](../../handovers/2026-06-03-tasks-projects.md) |
| 5 | **Memory + MCP Server + Hook Endpoints** — mem schema, hybrid search, enrichment loop (env provider), HTTP hooks for CC/Hermes, MCP tools (memories/docs/projects/tasks), scheduler tasks, GitHub-commit→memory. Deprecates the Python service. | ✅ shipped | [spec](../specs/2026-06-03-memory-mcp.md) | [plan](2026-06-03-memory-mcp.md) | [handover](../../handovers/2026-06-03-memory-mcp.md) |
| 6 | **Clipboard** — port `copipasta` as a page (self-contained; can slot in anytime). | ✅ shipped | [spec](../specs/2026-06-03-clipboard.md) | [plan](2026-06-03-clipboard.md) | [handover](../../handovers/2026-06-03-clipboard.md) |

### Round 2 — feedback after first-pass acceptance

| # | Cycle | Status | Spec | Plan | Handover |
|---|---|---|---|---|---|
| 7 | **Backend fixes & AI quality** — OCR retry-loop fix, tag cap (5–7), md-first transcription + title inference, memory auto-review threshold + relevance scores + reviewed-tag removal. | ✅ shipped | [spec](../specs/2026-06-03-backend-fixes.md) | [plan](2026-06-03-backend-fixes.md) | [handover](../../handovers/2026-06-03-backend-fixes.md) |
| 8 | **Global UX & architecture** — SPA conversion (SSR only for public pages), command palette (`UDashboardSearch`) with semantic search across docs/memories/gallery/tasks. | ✅ shipped | [spec](../specs/2026-06-03-spa-search.md) | [plan](2026-06-03-spa-search.md) | [handover](../../handovers/2026-06-03-spa-search.md) |
| 9 | **Documents power-editor** — custom MDC components + markdown toolbar (.md only), inline image paste→upload→embed, drag-drop move, context menu (rename/move/share/delete), copy-link, last-open cookie. | ✅ shipped | [spec](../specs/2026-06-03-doc-editor.md) | [plan](2026-06-03-doc-editor.md) | [handover](../../handovers/2026-06-03-doc-editor.md) |
| 10 | **Interaction polish** — Capture (paste/camera/drag-drop), Gallery (paste/DnD/video/filetype/search+tag-filter), Tasks (drag-drop + project/priority filters), Memories (add modal + tag filter), Clipboard (machine attribution). | ✅ shipped | [spec](../specs/2026-06-03-interaction-polish.md) | [plan](2026-06-03-interaction-polish.md) | [handover](../../handovers/2026-06-03-interaction-polish.md) |
| 11 | **Sessions view** — browse raw CC/Hermes transcripts + token usage / message count / tool-use stats. | ✅ shipped | [spec](../specs/2026-06-03-sessions-view.md) | [plan](2026-06-03-sessions-view.md) | [handover](../../handovers/2026-06-03-sessions-view.md) |

> Cycle ordering reflects dependencies: the spine underpins everything; enrichment makes it smart; capture/images/tasks are features on the spine; memory depends on docs/projects/tasks existing as MCP targets; clipboard is independent. Round 2 = polish/fixes on the shipped base; backend fixes (7) first, then architecture (8) before the UI-heavy editor/interaction work (9–10).

### Round 3 — planned (new scope; see [`docs/BACKLOG.md`](../../BACKLOG.md) for detail + open items)

| # | Cycle | Status | Spec | Plan | Handover |
|---|---|---|---|---|---|
| 12 | **AI model/provider registry** — DB-backed providers/models + per-usage failover-chain assignments in one JSONB `ai_config` doc; encrypted keys at rest (`CONFIG_ENC_KEY`, HKDF-from-`BETTER_AUTH_SECRET` fallback); `/settings` (3 tabs) + `/onboarding` wizard + redirect middleware; resolver hands decrypted failover chains to all AI consumers. Embeddings fixed at 2560-dim with a save-time dim-probe. The old `AI_*` env vars are now import-only seeds, not runtime config. **Shipped pending live E2E (merge gate).** | ✅ shipped | [spec](../specs/2026-06-10-ai-config-registry-design.md) | [backend](2026-06-10-ai-config-registry-backend.md) · [ui](2026-06-10-ai-config-registry-ui.md) | [handover](../../handovers/2026-06-10-ai-config-registry.md) |
| 13 | **API key management UI** — CRUD over `api_tokens` (mint/name/last-used/revoke) for ShareX uploads, CC/Hermes session-logging hooks, MCP. | planned | — | — | — |
| 14 | **In-app AI chat** — reasoning chat over docs/memories/projects/tasks via server-side tool-calling (reuses the MCP tool surface); cites sources, takes confirmed actions. Note: the shared agent core + text-chat endpoint (`/api/agent/chat`) shipped in cycle 17 — a full chat UI is what remains. | planned | — | — | — |
| 15 | **Capture/OCR robustness** — explicit dedup (untagged-only) + transcription retry (backoff / manual / auto-on-recovery) + surface OCR-failed & ambiguous-project to the notification queue. | planned | — | — | — |
| 16 | **CD → homelab Proxmox LXC** — single `deploy.yml` workflow: `test` job (lint non-blocking / typecheck / test / build) on every push gates a `deploy` job that runs on a self-hosted runner on the Proxmox host `mini`, tar-pipes the checkout into LXC 114 `/opt/mymind`, and `docker compose up -d --build` (migrate-on-start via Dockerfile CMD) + `/login` health check. Docs-only pushes skipped (`paths-ignore`). Chose the self-hosted-runner variant (LAN-only app box) over pull-based/SSH. **Shipped + live E2E green; verified on box (2026-06-10).** | ✅ shipped | [spec](../specs/2026-06-09-ci-deploy-pipeline-design.md) | [plan](2026-06-09-ci-deploy-pipeline.md) | [handover](../../handovers/2026-06-09-ci-deploy-pipeline.md) |
| 17 | **Voice Agent ("Jarvis")** — `/voice` page; Unmute STT/TTS with barge-in re-pointed at a Nitro agent loop (`/api/agent/llm`, OpenAI-spec); shared tool registry (11 tools) used by voice, MCP, and future text-chat; Three.js reactor; universal undo. Subsumes cycle 14 agent core. **Superseded by cycle 18.** | ✅ shipped | [spec](../specs/2026-06-08-voice-agent-jarvis-design.md) | [plan](2026-06-08-voice-agent-jarvis.md) | [handover](../../handovers/2026-06-08-voice-agent.md) |
| 18 | **Voice Agent v2 (self-hosted, self-orchestrated)** — Replaced Unmute with a fully owned TS pipeline: Silero VAD + WAV barge-in (client), Nitro WS orchestrator, swappable OpenAI-spec STT (faster-whisper) + TTS (Kokoro/Chatterbox) providers, Vercel AI SDK `runAgent` core shared by voice + chat + cron. Unmute stack removed. | ✅ shipped | [spec](../specs/2026-06-09-voice-self-hosted-redesign-design.md) | — | [handover](../../handovers/2026-06-09-voice-v2.md) |
| 19 | **Voice Visualizer Redesign** — Replaced placeholder wireframe icosahedron + 48-point ring with a GPU-particle Three.js visualizer: 50k-particle sphere core (GLSL vertex-shader motion), 96-bar instanced mic-frequency ring, tool pulse rings + transcription sparks. Pure-TS choreographer (14 unit tests) drives all state transitions and event impulses (barge-in shatter, error shockwave, sttFinal sparks, connect assembly). Quality tiers + FPS watchdog + context-loss rebuild + CSS fallback. `useVoice` gains `connecting`/`tool` states and `onVizEvent` emitter. Manual desktop+phone tuning pass pending. | ✅ shipped | [spec](../specs/2026-06-09-voice-visualizer-redesign-design.md) | [plan](2026-06-09-voice-visualizer-redesign.md) | [handover](../../handovers/2026-06-10-voice-visualizer.md) |

> Also tracked in the backlog (not yet cycled): GitHub-commits→memory, session-summarization worker, image semantic search, video→webm, EXIF scrub, bridget data migration, and assorted tech-debt. See [`docs/BACKLOG.md`](../../BACKLOG.md).

## Reference repos (read-only sources)

- `~/Documents/GitHub/codethis-dev` — Postgres document model, `public_slugs` sharing, language detection, Shiki + CodeMirror.
- `~/Documents/GitHub/bridget-services/command-center` — split file-tree/editor layout (Nuxt UI v4 `UDashboardPanel`), CodeMirror + MDC, edit/preview/split, the `fs`-seam to swap for Postgres.
- `~/Documents/GitHub/bridget-services/memory` — Python memory service: data model, two-stage dedup, hybrid RRF search, enrichment loop (design to port to TS).
- `~/Documents/GitHub/copipasta` — same stack (Nuxt 4 + Nuxt UI v4 + better-auth + Drizzle); storage abstraction, uploads, SSE, the Clipboard feature itself.
