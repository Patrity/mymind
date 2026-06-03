---
title: MyMind Master Roadmap
status: active
updated: 2026-06-02
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
| LLM/model access | **All connections env-configured, OpenAI-spec.** Roles: `reasoning`, `bulk`, `embeddings`, `vision`/OCR, `stt`, `tts` — each with `*_BASE_URL` / `*_API_KEY` / `*_MODEL`. Local default (AI rig `192.168.2.25`), hosted (Haiku / GPT / Gemini Flash via LiteLLM) for hard reasoning. Swapping a model = env change, never code. |
| Embeddings | `qwen3-embedding-4b`, **2560-dim**, stored as `halfvec(2560)` with HNSW cosine. TEI fronted to expose OpenAI `/v1/embeddings`. |
| Doc organization | **Hybrid**: canonical path tree (incl. `/input` staging) for the human browser, plus first-class queryable columns (`project`, `domain`, `type`, `tags`, `topic` ltree) promoted out of frontmatter. |
| Search | Trigram (keyword) from cycle 1; semantic + RRF fusion added in the enrichment cycle. |
| Auth | better-auth. Two surfaces: session (web) + bearer API tokens (machine clients: ShareX, CC/Hermes hooks, MCP). |
| Storage | Local-disk/S3 abstraction (ported from `copipasta`). |
| Backups | Handled **out-of-band** (nightly DB dump to an external service). Not an in-app concern. In-app markdown export is an optional future feature, not core. |
| AI safety | Every AI mutation (tags, frontmatter, filing, memories) is reviewable/reversible via a `reviewed_at`-style surface. |

## Cycle status

Legend: `planned` → `spec'd` → `in-progress` → `shipped`

| # | Cycle | Status | Spec | Plan | Handover |
|---|---|---|---|---|---|
| 1 | **Foundation + Content Spine** — app shell, dual auth, Drizzle/pg/pgvector, storage, document model, path-tree browser + CodeMirror/MDC editor (edit/preview/split), manual frontmatter, trigram search, public-slug sharing, env provider scaffold. Ships a manual-but-complete doc manager. | ✅ shipped | [spec](../specs/2026-06-02-foundation-content-spine.md) | [plan](2026-06-02-foundation-content-spine.md) | [handover](../../handovers/2026-06-03-foundation-content-spine.md) |
| 2 | **AI Enrichment + Notification Queue** — embedding worker (fills `halfvec`), semantic + RRF search, `/input` auto-tag/sort/frontmatter, AI-action review surface, human-needed notification queue. (+ login page fast-follow) | ✅ shipped | [spec](../specs/2026-06-03-ai-enrichment.md) | [plan](2026-06-03-ai-enrichment.md) | [handover](../../handovers/2026-06-03-ai-enrichment.md) |
| 3 | **Quick Capture + Image Hosting/Gallery** — quick note/todo/idea capture, image/gif/video upload (ShareX/CleanShot endpoints), sharp→webp/webm, OCR tags (confirmed + recommended), gallery, public/private. | in-progress | [spec](../specs/2026-06-03-capture-images.md) | [plan](2026-06-03-capture-images.md) | — |
| 4 | **Tasks + Projects (Kanban)** — projects (name/desc/active), kanban (todo/in-progress/completed/blocked), task fields + audit log, doc↔project↔domain relations. | planned | — | — | — |
| 5 | **Memory + MCP Server + Hook Endpoints** — mem schema, hybrid search, enrichment loop (env provider), HTTP hooks for CC/Hermes, MCP tools (memories/docs/projects/tasks), scheduler tasks, GitHub-commit→memory. Deprecates the Python service. | planned | — | — | — |
| 6 | **Clipboard** — port `copipasta` as a page (self-contained; can slot in anytime). | planned | — | — | — |

> Cycle ordering reflects dependencies: the spine underpins everything; enrichment makes it smart; capture/images/tasks are features on the spine; memory depends on docs/projects/tasks existing as MCP targets; clipboard is independent.

## Reference repos (read-only sources)

- `~/Documents/GitHub/codethis-dev` — Postgres document model, `public_slugs` sharing, language detection, Shiki + CodeMirror.
- `~/Documents/GitHub/bridget-services/command-center` — split file-tree/editor layout (Nuxt UI v4 `UDashboardPanel`), CodeMirror + MDC, edit/preview/split, the `fs`-seam to swap for Postgres.
- `~/Documents/GitHub/bridget-services/memory` — Python memory service: data model, two-stage dedup, hybrid RRF search, enrichment loop (design to port to TS).
- `~/Documents/GitHub/copipasta` — same stack (Nuxt 4 + Nuxt UI v4 + better-auth + Drizzle); storage abstraction, uploads, SSE, the Clipboard feature itself.
