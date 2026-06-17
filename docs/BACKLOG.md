# MyMind — Backlog & Spec Coverage

> The single source of truth for **what's left**. The [roadmap](superpowers/plans/00-roadmap.md) tracks shipped cycles; per-cycle handovers in [`handovers/`](handovers/) record what each delivered (their `deferred:` lists are point-in-time and partly superseded — this doc is the reconciled view). Last reconciled: 2026-06-16 — **cycle 13 (Bridget Parity) shipped** (broadened from "API key UI"): API-key CRUD + Connect-to-Claude-Code, capture-fidelity ingestion (tool_events/thinking/git/machine), one-time import of 457 claude_code sessions, session summarization + session/message search, and memory intelligence (provenance + a `memory_relations` graph + LLM relationship-judge with auto-supersede + review-gated contradictions). On `feat/bridget-parity` (not yet merged); closes the §3 session-summarization + bridget-migration items and the session/message-search gap. Earlier: **cycle 22 (Activity Log / Observability) shipped**: a centralized live `activity_log` ledger (inbound + jobs + model-per-attempt + agent tool/reasoning), `/activity` UI with trace-tree detail + ack, severity-tiered prune, and badge/toast/**Resend email** alerts configurable in `/settings`. Stands up Resend (closes the Email item below). See [`wiki/activity-log.md`](wiki/activity-log.md). Remaining: live E2E with the rigs (pending acceptance) + the deferred model request/response body capture. (Cycle 21 Live Reactivity shipped 2026-06-12; its full multi-resource cross-tab E2E sweep is still open.) **Reconciled 2026-06-17 — the entire Projects line shipped + deployed to prod (cycles 23–27):** canonical git-keyed projects + session/memory association (23), sessions UX/SSE (24), projects UI + per-project colour (25), the `/projects/[slug]` **dashboard** + editable-slug cascade (25-followup), **document↔project association** via the `/projects/<slug>/` path invariant + `documents.project_id` (migration 0021) (26), and **project merge** (27). See [`wiki/projects.md`](wiki/projects.md) + the cycle-23→27 handovers.

---

## 1. Original spec coverage

The original `scope.md` braindump (since removed from the repo) defined 8 areas. Status:

| Area | Status |
|---|---|
| Document management (MDC, `/input` staging, frontmatter, split editor, public sharing, search) | ✅ shipped (cycles 1, 9) |
| Tasks & projects (kanban, audit) | ✅ shipped (4) |
| Image hosting / gallery (ShareX endpoints, sharp→webp, OCR confirmed+recommended tags, public/private) | ✅ shipped (3, 10) |
| Quick capture (note/idea, image, handwriting→Markdown) | ✅ shipped (3, 10) |
| Memory system (CC/Hermes hooks, enrichment, embedding, dedup, hybrid search) | ✅ shipped (5) |
| MCP server (memories/docs/projects/tasks tools) | ✅ shipped (5) |
| AI integration (local models, env-configured) | ✅ shipped (2, 5) — but see gaps below |
| Clipboard (device-sync, live SSE) | ✅ shipped (6) |

### Gaps vs the original vision (not built)
- **GitHub-commits → memory/notes/docs** — an explicit Memory-System task; never built. → planned (§2).
- **In-app "agent loop" (skills / tools / code execution / fs ops)** — reframed as the MCP server (external agents drive MyMind). Substantially addressed by **cycle 18 (Voice Agent v2)**: the AI SDK `runAgent` core (`server/lib/agent/`) + text-chat endpoint (`/api/agent/chat`) are shipped; the voice UI is live (self-hosted STT/TTS, no Unmute dependency). **Cycle 17 Unmute path is removed and superseded.** ✅ The **text-chat UI shipped as the unified `/agent` surface (cycle 28)** — talk+type in one place, persisted/searchable conversations, editable Bridget personality. Full code-execution loop = **Cycle B** (deferred, security-first; task `d1d7f0ab`).
- **Full notification system** — the spec wanted human-attention alerts (OCR failed, can't determine project, frontmatter suggested). Only the **review queue** (enrichment proposals) exists; OCR-failed / ambiguous-project are not surfaced. → planned (§2/§3).
- **Video → webm transcode** — ffmpeg installed; video stored passthrough, not converted. → §3.
- **Voice (STT/TTS)** — ✅ shipped (cycle 18): self-hosted faster-whisper STT + Kokoro/Chatterbox TTS, client Silero VAD, Nitro WS orchestrator. In-app text-chat UI (cycle 14) rides the same AI SDK `runAgent` core.
- ~~**Email (ReSend)** — was "if needed"; not built. Optional.~~ ✅ **shipped (cycle 22)** — Resend wired as the activity-log error-alert channel (severity-gated, windowed digest), configurable in `/settings → Activity & Alerts`. A general-purpose transactional-email use beyond error alerts is still open if ever needed.

---

## 2. Planned features (Round 3)

New scope beyond the original spec. Suggested order reflects dependencies (the model registry underpins the chat; auth/keys are quick wins). Numbers are *proposed* cycles — reorder freely.

### Cycle 12 — AI model/provider registry (DB-backed, replaces env)
Move provider config out of `.env` into the database with a settings UI.
- `providers` table (name, base_url, api_key [encrypted], kind/openai-spec) + `models` table (provider_id, model_id, capabilities: chat/embed/vision/rerank, context, notes).
- `task_assignments` — map each **role** (`reasoning`/`bulk`/`embeddings`/`vision`/`stt`/`tts`/`rerank`) to a chosen model. `aiProvider(role)` resolves from the DB registry, falling back to env if unset (keeps current behaviour working during migration).
- Settings UI: CRUD providers + models, a "test connection" button, and a role→model assignment panel. API keys stored encrypted at rest (not returned to the client after save).
- *Why:* swap/add models without redeploying; see which model does what at a glance.

### Cycle 13 — Bridget Parity ✅ shipped (broadened from "API key management UI (CRUD)")
Shipped in 5 phases on `feat/bridget-parity` (see the [handover](handovers/2026-06-16-bridget-parity.md)): API-key CRUD + Connect-to-CC, capture fidelity, 457-session import, summaries+search, memory intelligence. Original scope below (delivered + exceeded):

A settings page over the existing `api_tokens` table (today tokens are inserted by hand).
- Create (name + scopes/notes; show the plaintext token **once**), list (name, created, last-used, masked), revoke. For ShareX/CleanShot uploads, CC/Hermes session-logging hooks, and MCP.
- Optional: per-token scope (upload-only vs full) — currently all tokens are equal.

### Cycle 14 — In-app AI chat over your data (docs / tools / projects)
A reasoning chat assistant inside the app — the pragmatic slice of the "agent loop."
- Chat UI; backend uses `chat('reasoning')` with **tool-calling** wired to the existing services (search_docs, search_memories, list/create tasks, list projects, create memory — the same surface as MCP, reused server-side).
- Streams responses; cites the docs/memories it used; can take actions (create a task, save a memory) with confirmation. Reuses the model registry (§12) for the chat model.
- *Not* arbitrary code execution — tool-scoped only (revisit fs/code later if wanted).

### Cycle 15 — Capture/OCR robustness (dedup + retry + failure surfacing)
Harden the image pipeline (some of this exists — make it solid + visible).
- **Dedup tagging/transcription** — *current:* OCR only processes `ocr_text IS NULL` images (untagged), so it already skips processed ones. **Do:** make the "needs processing" gate explicit + extend the same untagged-only guarantee to any re-tag path; ensure changed/re-uploaded images re-process intentionally, not accidentally.
- **Retry logic for failed transcriptions** — *current:* bounded 3-attempt cap via `ocr_attempts` (stops infinite loops). **Do:** add backoff between attempts, a manual "retry failed" action in the gallery, and auto-retry when the vision endpoint recovers (don't permanently bury a doc that failed only because `:8005` was down).
- **Failure surfacing** — enqueue `ocr-failed` / `ambiguous-project` into the review/notification queue instead of just `console.warn` (closes the original-spec notification gap). *Note (cycle 22): the activity log now captures `error`/`warn`-kind rows for these failures (visible at `/activity` + badge/toast/email), so this is the seam — the remaining work is the **actionable** review-queue entry for human follow-up, distinct from the observability row.*

### Cycle 16 — CD: deploy to homelab Proxmox LXC
Automated deploy on merge to `master`.
- GitHub Actions: lint/typecheck/test (extend the existing `.github/workflows/ci.yml`) → build the Docker image → deploy to the LXC.
- Delivery options (pick one): a **self-hosted runner** on the LXC that runs `docker compose -f docker-compose.prod.yml up -d --build`; OR push the image to a registry (GHCR) + a **pull-based** updater on the LXC (watchtower/cron `docker compose pull && up -d`); OR SSH deploy over a tunnel. Pull-based is simplest for a NAT'd homelab.
- Run `pnpm db:migrate` as part of the deploy (the prod image already self-migrates on start).

---

## 3. Open items from build reviews (quality · security · scale)

Carried out of the 11 cycle handovers, de-duplicated, current items only:

**AI quality**
- ~~Session-summarization worker — sessions show "(untitled session)"; generate title+summary (bridget had this).~~ ✅ **shipped (cycle 13 phase 4)** — `summarize-sessions` task → title+summary+`summary_embedding`; + session/message semantic search in the palette.
- Reranker (`:8883`) wired but OFF by default — enable + evaluate for memory/doc relevance.
- ~~Image **semantic** search — gallery search is keyword/exact-tag only; add image embeddings + vector search.~~ ✅ **shipped (cycle 20)** — `images.embedding halfvec(2560)` (summary embedding) + `searchImages` hybrid trigram + vector RRF.
- Bridget **raw data migration** — ✅ **shipped (cycle 13 phase 3)**: `scripts/migrate-bridget-sessions.ts` imported 457 claude_code sessions/messages/tool_events (raw; memories regenerated locally, NOT imported). Remaining: run against PROD `DATABASE_URL`; optionally import hermes (`--source=hermes`).
- Larger/steadier vision model — `:8005` (8B) is weak/flaky; transcription leans on the 27B cleanup.

**Security / ops (before wider exposure)**
- EXIF/metadata scrub on uploads (orientation is applied; full strip isn't).
- Optimistic concurrency on doc autosave (currently last-writer-wins).
- Leaner `.output`-only Docker runtime image (current image keeps full deps to self-migrate).
- Redis pub/sub for clipboard SSE *if* ever running >1 instance (today: single in-process EventEmitter).
- Rate-limit `/api/auth`, `/api/upload`, `/api/hooks` at the proxy.

**Minor tech-debt**
- `::callout` resolves to MDC's built-in; custom type-colored one is `::mc-callout` (rename or override the prose map to unify).
- `messages.session_id` FK + `ON DELETE CASCADE` (no FK today).
- `listSessions` raw-`sql` where → `and()/eq()`.
- Multiple-clipboard-threads UI (schema supports many; UI uses one default thread).
- Token-cost ($) display on sessions (raw counts only).
- Tasks: subtasks/checklists, recurring, reminders, calendar view, manual in-column reordering. (~~doc↔project↔task cross-view~~ ✅ shipped — the `/projects/[slug]` dashboard has Sessions/Tasks/Memories/Documents tabs.)
- Per-surface deep-links (`?task=`/`?img=`/`?focus=`/`?doc=` were stripped pending page support — the projects-dashboard doc-tab rows currently link to `/documents`, not a per-doc deep-link).

---

## 4. Doc hygiene
- Handover `deferred:` blocks are point-in-time; several listed items shipped in later cycles (login, drag-drop, deep-links, semantic search…). **This doc supersedes them** for "what's left."
- When a Round-3 cycle ships, update its roadmap row + add/refresh the relevant wiki page, and tick the item here.

---

## 5. Next direction (post-projects, 2026-06-17)

With the projects backbone in place (canonical entities + association + dashboard + merge), the next themes (not yet spec'd — each gets its own brainstorm → spec → plan cycle):

- **A real agent loop** — ✅ **Cycle A shipped (cycle 28, 2026-06-17)**: `/voice`→`/agent` unified surface (talk+type, one WS, `speak` is the sole branch), conversation persistence + history/search/resume, and a real editable/context-aware/time-of-day **Bridget** personality. Profile-aware `runAgent` (`AgentProfile`) is the seam. See [`wiki/agent.md`](wiki/agent.md) + the [cycle-28 handover](handovers/2026-06-17-agent-surface-chat.md). **Cycle B (next, deferred — mymind task `d1d7f0ab`):** the powerful capability tools (deep web research / SSH / local terminal / file-edit-for-reports / `gh`) + the **execution-model & security** design — this is where the project deliberately breaks the locked "no arbitrary code execution" rule, so it gets its own security-first brainstorm. Still tool-scoped + review-gated where it can be.
- **Better / more MCP tools for coding agents** — *first batch shipped 2026-06-17 (registry 11 → 15):* `get_project`, `list_documents`, `get_document`, `save_document` (auto-files into `/projects/<slug>/`), + a `project` filter on `search_docs` (see [`handovers/2026-06-17-mcp-project-tools.md`](handovers/2026-06-17-mcp-project-tools.md)). Still open: doc **edit** (`edit_document`), structured task/memory queries, and live-MCP exercise of the new tools. Keep each tool concise + well-scoped.
- **Deep but scoped knowledge/memory** — lean on the enrichment loop (concise, confidence-scored, session-linked, project-scoped memories) as the primary inlet; reserve `save_memory` (now with a `confidence` param) for concise cross-session facts. Explore richer project-scoped recall + the `memory_relations` graph (supersede/contradict) surfacing.
- Carry-overs still open: **in-app text-chat UI** (§2 cycle 14), **capture/OCR robustness** (§2 cycle 15), **GitHub-commits → memory** (§1 gap), the **reranker** (off by default), and the cosmetic follow-ups in §3.
