# MyMind — Backlog & Spec Coverage

> The single source of truth for **what's left**. The [roadmap](superpowers/plans/00-roadmap.md) tracks shipped cycles; per-cycle handovers in [`handovers/`](handovers/) record what each delivered (their `deferred:` lists are point-in-time and partly superseded — this doc is the reconciled view). Last reconciled: 2026-08-27 — **cycle 60 (Agent surface redesign) built** (`feat/agent-surface-redesign`, unmerged): four of six agent-page complaints closed, two blocked on a human (the MakeHuman head export and Orpheus on the rig) — see §2 below and the [cycle-60 handover](handovers/2026-08-27-agent-surface-redesign.md). Previously reconciled 2026-08-25 (cycle 59, documents folders). Earlier: 2026-07-15 — **cycle 46 (Session↔Project Reassignment + Path-Based Auto-Routing) built** (`feat/session-project-reassignment`, unmerged): closes the cycle-23 gap where a no-git-remote session with no label match was stuck in `uncategorized` with no way out — reassignment (single/bulk, agent-memory cascade), a learned `path_prefixes` routing column (auto-create + manual reassign both write it), `git_root` label matching, hostname surfacing/filter, and a one-time existing-projects-only re-resolve backfill (not yet run on prod). See [`wiki/sessions.md`](wiki/sessions.md) + [`wiki/projects.md`](wiki/projects.md) + the [cycle-46 handover](handovers/2026-07-15-session-project-reassignment.md). Operational steps, re-checked against prod 2026-08-05: **merged** ✅ and the **Terawulf cluster is drained** ✅ (the `terawulf` project holds 34 sessions with 4 registered `path_prefixes`; uncategorized is down to 23). Whether `scripts/reresolve-uncategorized.ts` itself was run on prod is **not determinable from the data** — the drain could equally be the UI bulk-reassign path. Tracked in §5. Previously reconciled 2026-06-16 — **cycle 13 (Bridget Parity) shipped** (broadened from "API key UI"): API-key CRUD + Connect-to-Claude-Code, capture-fidelity ingestion (tool_events/thinking/git/machine), one-time import of 457 claude_code sessions, session summarization + session/message search, and memory intelligence (provenance + a `memory_relations` graph + LLM relationship-judge with auto-supersede + review-gated contradictions). On `feat/bridget-parity` (not yet merged); closes the §3 session-summarization + bridget-migration items and the session/message-search gap. Earlier: **cycle 22 (Activity Log / Observability) shipped**: a centralized live `activity_log` ledger (inbound + jobs + model-per-attempt + agent tool/reasoning), `/activity` UI with trace-tree detail + ack, severity-tiered prune, and badge/toast/**Resend email** alerts configurable in `/settings`. Stands up Resend (closes the Email item below). See [`wiki/activity-log.md`](wiki/activity-log.md). Remaining: live E2E with the rigs (pending acceptance) + the deferred model request/response body capture. (Cycle 21 Live Reactivity shipped 2026-06-12; its full multi-resource cross-tab E2E sweep is still open.) **Reconciled 2026-06-17 — the entire Projects line shipped + deployed to prod (cycles 23–27):** canonical git-keyed projects + session/memory association (23), sessions UX/SSE (24), projects UI + per-project colour (25), the `/projects/[slug]` **dashboard** + editable-slug cascade (25-followup), **document↔project association** via the `/projects/<slug>/` path invariant + `documents.project_id` (migration 0021) (26), and **project merge** (27). See [`wiki/projects.md`](wiki/projects.md) + the cycle-23→27 handovers.

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

### From the 2026-08-15 UX audit — deferred out of cycle 56 (Home dashboard)
The [cycle-56 spec](superpowers/specs/2026-08-15-home-dashboard-design.md)'s "Out of scope"
section named four adjacent findings from [`docs/explorations/2026-08-15-ux-audit-product.md`](explorations/2026-08-15-ux-audit-product.md)
and deliberately left each out — "folding any of them in makes this unshippable." Each is its
own future cycle. **Two of the four are now closed** (2026-08-25 reconcile — see the struck
entries below); the remaining two are capture titling and sidebar IA:

- **Capture titling.** User captures get machine-generated names (e.g. `/input/9O8RQk4EOZ.md`),
  so the `/input` inbox can't be browsed by anything meaningful — every row reads as a random
  slug. The single highest-value follow-up per the audit. Needs a title-inference pass (mirrors
  the cycle-7 md-first transcription title inference already shipped for uploads) applied to
  quick-capture notes too.
- **Sidebar IA.** Four separate inboxes, four activity surfaces, conversations split across two
  stores under three different names — the navigation no longer reflects one coherent
  information architecture as features have accreted cycle over cycle. Needs a dedicated
  audit-and-consolidate pass, not a drive-by fix.
- ~~**Login deep-link preservation.**~~ ✅ **fixed 2026-08-25.** The guard now bounces to
  `/login?redirect=<to.fullPath>` and `login.vue` consumes it through `safeRedirect()`
  (`app/lib/auth-redirect.ts`, unit-tested), which rejects `//host`, `/\host`, absolute URLs,
  control characters and `/login` itself so the param can't become an open redirect. Verified
  in the browser both ways: with the fix a logged-out hit on `/projects/mymind` lands back
  there after sign-in; stashing it reproduced the old bare `/login`. See [`wiki/auth.md`](wiki/auth.md).
- ~~**Document editor silent data loss.**~~ ✅ **already fixed 2026-08-16** by `4a3792f`, the day
  after the audit — this entry was stale at the time of the cycle-56 reconcile. `Editor.vue`
  now tracks `savedContent`/`dirty`, renders an `unsaved` badge, guards tab close with
  `beforeunload`, and **flushes** (rather than discarding) the pending save on unmount and on
  document switch; the debounce logic moved to a tested `app/lib/documents/autosave.ts` that
  carries the `(id, content)` pair so a late save can't write into the wrong document.

### Six documents-page complaints (raised 2026-08-25) — ✅ all closed same-cycle (cycle 59)
Tony's own words, closed by [cycle 59](superpowers/plans/00-roadmap.md) (`worktree-feat+documents-folders-ux`,
built but not yet merged — see the [handover](handovers/2026-08-25-documents-folders-ux.md)) and
browser-verified with evidence rather than assumed from the diff:
- ~~**Right-clicking a folder did nothing.**~~ ✅ Full context menu now (New document here/New
  subfolder/Rename/Move/Colour/Copy path/Collapse all/Delete).
- ~~**Only files could be dragged, not folders.**~~ ✅ Both drag via `useSortable`; dropping a file
  onto a folder's own row files it into that folder.
- ~~**Deleting a folder's last document made the folder vanish.**~~ ✅ Folders are now a real
  registry row (`folders` table) independent of content — they persist empty until explicitly deleted.
- ~~**Creating a document required hand-typing a path.**~~ ✅ A `USelectMenu` folder picker replaces it.
- ~~**Opening an empty document showed a blank preview pane.**~~ ✅ An empty document now always
  opens in Edit mode.
- ~~**Folders couldn't be coloured.**~~ ✅ A 14-swatch colour picker, inherited down the tree the
  same way project colours already worked.

Also closes cycle 58's `USelectMenu` sweep note: MyMind task `7be76abc` ("All project select
dropdowns should be USelectMenu") was already completed in cycle 58 itself (the last 8 `<USelect>`
in `tasks.vue` converted) — restated here as complete since cycle 59's own task brief asked this
doc to confirm it.

### Six agent-page complaints (raised 2026-08-27) — ✅ four closed same-cycle, two blocked on a human (cycle 60)

Tony's own words, addressed by [cycle 60](superpowers/plans/00-roadmap.md)
(`feat/agent-surface-redesign`, built but not merged — see the
[handover](handovers/2026-08-27-agent-surface-redesign.md)). Each was **measured in a live browser
before and after**, not assumed from the diff:

- ~~**The chat UX is bad.**~~ ✅ Three-column shell (threads / conversation / Bridget) replacing the
  75%-canvas split; autoscroll with a bottom pin and a "↓ N new" release (the transcript previously
  had **no scroll handling at all** — 2,459 px of reply streamed below the fold and the view never
  moved); a multiline composer with Shift+Enter and a working Stop; per-message copy/retry/timestamp/
  token count; a real empty state. **Also fixed in passing:** a single `hidden lg:flex` meant the
  composer measured `0×0` below 1024 px, so the page had **no chat at all** on a phone or tablet.
- ~~**No ability to view past conversations.**~~ ✅ The defect was **navigation**, not a missing
  feature — `/agent/history` was already complete (search, counts, resume, `?c=` deep links) and
  simply had no sidebar entry. It has one now, plus a permanent thread rail, the current thread's
  title in the toolbar, and a delete confirmation.
- ~~**TTS speaks markdown aloud.**~~ ✅ A pure `toSpeakable()` sanitizer at the choke point — the
  prompt asks, this enforces. The same bug was visible in the UI (the full-bleed caption printed raw
  `#`/`**`) and is fixed by the same cycle.
- ~~**TTS cadence is wrong / it fragments.**~~ ✅ A decimal- and abbreviation-aware segmenter replaced
  `SentenceChunker`, whose regex split on **every** period — `192.168.2.25` became four separate TTS
  calls with a network round-trip between each. `sentenceMinChars` 60→140, breaking at a clause
  boundary. ⚠️ **But see the open item below: the `playbackRate` half of this did not take effect.**
- **Voice quality (the model).** ⏳ **NOT closed — blocked on a human.** Orpheus 3B was never stood
  up; it needs shell on the rig at `192.168.2.25`. The TTS model is still Kokoro/Chatterbox. The app
  side is already pure configuration (the registry takes any OpenAI-spec `/v1/audio/speech`), so this
  is a rig task, not a code task. The serving recipe and its landmines — the `orpheus-speech` PyPI
  package returning HTTP 200 with an empty body, core vLLM not serving TTS at all, and the rig's
  installed Chatterbox being the original 0.5B at 4 s TTFB — are in the handover.
- **The 3D should be a face, not a sphere.** ⏳ **Built, but not visible — blocked on a human.** The
  `Avatar` seam, the seeded choreographer, the bake script, the `ParticleHead` renderer and full-bleed
  mode all shipped and are green; but `assets/source/bridget-head.glb` does not exist. It must be
  generated in an **official, unmodified MakeHuman build**, which is what makes the export **CC0**
  (FLAME and the Basel Face Model were rejected as research-licence-only). Until then `/agent` renders
  the CSS fallback. Steps: export → commit the `.glb` → `pnpm bake:head` → **commit
  `app/assets/head-points.bin`** (deliberately not gitignored; prod cannot run MakeHuman) → **rebuild**
  (`import.meta.glob` resolves at build time, so a dropped `.bin` is invisible to a running build).

**New open item from cycle 60's own documentation pass:** `VOICE_TUNING.tts.playbackRate` was moved
1.1 → 1.0 per the spec, but **that constant has no reader** — playback is driven solely by
`VOICE_SETTINGS_DEFAULTS.playbackRate` in `app/composables/useVoiceSettings.ts`, which is **still
1.1**. The audible rate did not change for anyone. One-line fix; **settle it before judging Orpheus
against Kokoro**, or the control in that comparison is not a control.

**Also deferred from cycle 60:** the spec asked for a rename/delete **row context menu on the thread
rail** and the plan assigned it to no task — not built. Nothing is unreachable (both live on
`/agent/history`, which the sidebar now surfaces). Sixteen further deferred minors are itemized in the
handover.

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
- (Cycle 46) `findOrCreateProject`'s auto-create path swallows any non-race insert error and silently degrades to Uncategorized with no log — asymmetric with the git-remote branch; a targeted re-select+log would close it.
- (Cycle 46) `reassignSession`/`reassignSessions` read the target project row before opening the transaction — a theoretical lost-update race on `path_prefixes` under concurrent reassigns to the same project. Negligible single-user.
- (Cycle 46) Sessions-list `selectedIds` isn't pruned when an active filter hides a selected row.

---

## 4. Doc hygiene
- Handover `deferred:` blocks are point-in-time; several listed items shipped in later cycles (login, drag-drop, deep-links, semantic search…). **This doc supersedes them** for "what's left."
- When a Round-3 cycle ships, update its roadmap row + add/refresh the relevant wiki page, and tick the item here.

---

## 5. Next direction (post-projects, 2026-06-17)

With the projects backbone in place (canonical entities + association + dashboard + merge), the next themes (not yet spec'd — each gets its own brainstorm → spec → plan cycle):

- **A real agent loop** — ✅ **Cycle A shipped (cycle 28, 2026-06-17)**: `/voice`→`/agent` unified surface (talk+type, one WS, `speak` is the sole branch), conversation persistence + history/search/resume, and a real editable/context-aware/time-of-day **Bridget** personality. Profile-aware `runAgent` (`AgentProfile`) is the seam. See [`wiki/agent.md`](wiki/agent.md) + the [cycle-28 handover](handovers/2026-06-17-agent-surface-chat.md). ✅ **Cycle B1 shipped (cycle 29, 2026-06-17)**: `web_search` + `web_fetch` read-only tools on the default toolset; SSRF-guarded; SearXNG bundled; `web_fetch` live-validated; `web_search` deploy-pending. See [`wiki/web-research.md`](wiki/web-research.md) + the [cycle-29 handover](handovers/2026-06-17-web-research-b1.md). **Cycle B2+ (deferred — mymind task `d1d7f0ab`):** approval-gate harness + constrained exec + SSH / `gh` / file-edit — the execution-model & security design. Still tool-scoped + review-gated where it can be.
- **Better / more MCP tools for coding agents** — *first batch shipped 2026-06-17 (registry 11 → 15):* `get_project`, `list_documents`, `get_document`, `save_document` (auto-files into `/projects/<slug>/`), + a `project` filter on `search_docs` (see [`handovers/2026-06-17-mcp-project-tools.md`](handovers/2026-06-17-mcp-project-tools.md)). Still open: doc **edit** (`edit_document`), structured task/memory queries, and live-MCP exercise of the new tools. Keep each tool concise + well-scoped.
- **Deep but scoped knowledge/memory** — lean on the enrichment loop (concise, confidence-scored, session-linked, project-scoped memories) as the primary inlet; reserve `save_memory` (now with a `confidence` param) for concise cross-session facts. Explore richer project-scoped recall. ✅ **`memory_relations` graph (supersede/contradict) surfacing shipped in cycle 47 (Knowledge Galaxy)** — the graph is now visible + editable (draw/remove relations) in the 3D `/galaxy` view, alongside every other entity; closes task e356a621. See [`wiki/galaxy.md`](wiki/galaxy.md) + the [cycle-47 handover](handovers/2026-07-16-knowledge-galaxy.md).
- **Knowledge Galaxy — ✅ shipped (cycle 47, 2026-07-16, merged + pushed → CD deploy).** Interactive 3D `/galaxy` graph over the whole second brain (~1,907 nodes / 2,850 edges), positioned by a UMAP projection of the shared 2560-dim embedding space, connected by structural edges, full CRUD + draw-relation, live-reactive. Remaining **operational** step (not code): after the CD deploy, `graph_layout` is empty on prod until the nightly cron runs — trigger `POST /api/graph/recompute` (authed) to populate it immediately. Deferred fast-follows: incremental (non-full) `['graph']` refetch; off-thread recompute if ever UI-exposed.
- **Session ↔ project reassignment gap — ✅ closed (cycle 46, 2026-07-15), branch merged.** Sessions can now be moved to any project (single or bulk UI), which cascades their agent-scoped memories and can teach the router a new `path_prefixes` root so the same folder auto-routes correctly next time. **Operational follow-through verified on prod 2026-08-05:** the `Terawulf` project exists with **4 `path_prefixes` and 34 sessions**, and uncategorized is down to **23** — the cluster is drained and auto-routing is live. (Whether `scripts/reresolve-uncategorized.ts` was the mechanism or the UI bulk-reassign was is not recoverable from the data; either way the outcome is achieved.) **Still open:** the wider prefix-registration gap — 12 no-remote projects have zero `path_prefixes`, led by `claude-agent` at **112 sessions**, so they still depend on fragile basename matching. Tracked as MyMind task `227d7bf1`. See [`wiki/sessions.md`](wiki/sessions.md) + [`wiki/projects.md`](wiki/projects.md) + the [cycle-46 handover](handovers/2026-07-15-session-project-reassignment.md).
- Carry-overs still open: **in-app text-chat UI** (§2 cycle 14), **capture/OCR robustness** (§2 cycle 15), **GitHub-commits → memory** (§1 gap), the **reranker** (off by default), and the cosmetic follow-ups in §3.
