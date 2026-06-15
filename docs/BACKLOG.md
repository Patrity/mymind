# MyMind — Backlog & Spec Coverage

> The single source of truth for **what's left**. The [roadmap](superpowers/plans/00-roadmap.md) tracks shipped cycles; per-cycle handovers in [`handovers/`](handovers/) record what each delivered (their `deferred:` lists are point-in-time and partly superseded — this doc is the reconciled view). Last reconciled: 2026-06-15 — **cycle 22 (Activity Log / Observability) shipped**: a centralized live `activity_log` ledger (inbound + jobs + model-per-attempt + agent tool/reasoning), `/activity` UI with trace-tree detail + ack, severity-tiered prune, and badge/toast/**Resend email** alerts configurable in `/settings`. Stands up Resend (closes the Email item below). See [`wiki/activity-log.md`](wiki/activity-log.md). Remaining: live E2E with the rigs (pending acceptance) + the deferred model request/response body capture. (Cycle 21 Live Reactivity shipped 2026-06-12; its full multi-resource cross-tab E2E sweep is still open.)

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
- **In-app "agent loop" (skills / tools / code execution / fs ops)** — reframed as the MCP server (external agents drive MyMind). Substantially addressed by **cycle 18 (Voice Agent v2)**: the AI SDK `runAgent` core (`server/lib/agent/`) + text-chat endpoint (`/api/agent/chat`) are shipped; the voice UI is live (self-hosted STT/TTS, no Unmute dependency). **Cycle 17 Unmute path is removed and superseded.** A full **text-chat UI** (cycle 14) is still pending — the backend is ready. Full code-execution loop is a deliberate maybe-not.
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

### Cycle 13 — API key management UI (CRUD)
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
- Session-summarization worker — sessions show "(untitled session)"; generate title+summary (bridget had this).
- Reranker (`:8883`) wired but OFF by default — enable + evaluate for memory/doc relevance.
- ~~Image **semantic** search — gallery search is keyword/exact-tag only; add image embeddings + vector search.~~ ✅ **shipped (cycle 20)** — `images.embedding halfvec(2560)` (summary embedding) + `searchImages` hybrid trigram + vector RRF.
- Bridget memory **data migration** — import the old Python service's memories (one-time).
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
- Tasks: subtasks/checklists, recurring, reminders, calendar view, doc↔project↔task cross-view, manual in-column reordering.
- Per-surface deep-links (`?task=`/`?img=`/`?focus=` were stripped pending page support).

---

## 4. Doc hygiene
- Handover `deferred:` blocks are point-in-time; several listed items shipped in later cycles (login, drag-drop, deep-links, semantic search…). **This doc supersedes them** for "what's left."
- When a Round-3 cycle ships, update its roadmap row + add/refresh the relevant wiki page, and tick the item here.
