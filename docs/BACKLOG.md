# MyMind — Backlog & Spec Coverage

> The single source of truth for **what's left**. The [roadmap](superpowers/plans/00-roadmap.md) tracks shipped cycles; per-cycle handovers in [`handovers/`](handovers/) record what each delivered (their `deferred:` lists are point-in-time and partly superseded — this doc is the reconciled view). Last reconciled: 2026-09-22 — **cycle 68 (agent chat affordances) built** (`feat/chat-affordances`, unmerged and undeployed, but **cut from a DEPLOYED baseline** — master is pushed and live as of 2026-09-21, so the only thing between this branch and prod is its migration): a conversation is now a **tree**. `conversations.active_leaf_id` (**migration `0045_busy_solo.sql` — additive, self-healing, NOT YET RUN ON PROD**) names the path being read, and one `loadActivePath` resolves it for **both** readers — the UI's `getConversation` and the model's `getAgentHistory` — which is the property the whole cycle exists to protect: if those two ever disagreed, the model would answer a conversation nobody is reading and nothing in the UI would say so. **The framing worth keeping: a third of the complaint that started this cycle ("no copy message button, no fork conversation at message, missing lots of stuff") was a DISCOVERABILITY defect, not a feature gap** — copy, regenerate, the timestamp and a token count already existed in `ReplyActions.vue` behind `opacity-0 group-hover:opacity-100`, invisible until hover and unreachable on touch. **Behaviour change to flag: retry used to TRUNCATE the thread and now BRANCHES** (the previous reply stays reachable through a ‹ n/N › pager; `app/lib/agent/retry.ts` is deleted). Fork/edit/regenerate are one primitive, nothing is ever deleted, and duration + tok/s now render live during a turn. **All 10 live-validation items PASS**, tree shapes read directly out of Postgres, including a pre-cycle thread resuming untouched (the migration's real test) and the cycle-65 one-WebGL2-canvas invariant counted as *contexts, not canvases*. Bundle: no new chunk, +94 B gzip. **The transferable finding is about tests — five of this cycle's findings were tests that could not fail, each caught by breaking the code on purpose and watching the suite stay green.** See §2. Previously reconciled 2026-09-20 — **cycle 67 (voice studio refactor) built** (`feat/voice-studio-refactor`, unmerged and unpushed): **this closes the four-cycle "agent surfaces on AI Elements" program.** `DesignPane.vue` went **1,101 → 454 lines**, split into three children plus `useRigRender.ts`; `SpeakPane`'s textarea is now composer chrome; `SettingsSlideover.vue` moved to `components/agent/`. **Deliberately the smallest cycle of the four, because measuring the deferred line found two thirds of it empty — Home was declined and "shared voice pieces" had nothing to share** (see §2). **The only user-visible change in the entire cycle is the microphone fix:** reference-clip recording ignored the `micDeviceId` the settings slideover sets, so the studio silently recorded on the system default while the live agent used the chosen device. **No migration, and no server file touched — the whole diff is 11 files under `app/`.** All **9 live-validation items PASS** against a reachable rig, zero console errors; the 375px speak-panel gap found alongside them was proven pre-existing by a controlled probe against the branch base (same split-pane defect as MyMind task `9745f72d`). Bundle +2,152 B gzip (+0.10%). **The transferable finding is about process:** two of the controller's own briefs invented interfaces the original code never had, caught only because implementers flagged rather than built and reviewers diffed against the pre-refactor file rather than the brief. **With the program done, the merge/push backlog — 90 commits, four stacked unpushed cycles, one unrun migration, and the prod-build OOM fix living only on cycle 65's branch — is the repo's largest open risk.** Previously reconciled 2026-09-20 — **cycle 66 (`/sessions/[id]` on AI Elements) built** (`feat/sessions-elements`, unmerged and unpushed): the session transcript now **pages** instead of loading whole sessions in one query (keyset pagination over a `(created_at, id)` cursor, 100 per page, capped at 200), **filters server-side** (hide subagent, by tool name, find-in-session — the live-tail delta carries them too), and renders each row on the **AI Elements** primitives through a pure `sessionToolState` adapter, with `@tanstack/vue-virtual` measuring rows instead of guessing 140px. **Two things to know before touching it:** ordering now breaks `created_at` ties by `id`, which is a correctness fix but changes the rendered order of **26% of all messages** (58,417 of 228,692 share a timestamp; the largest tie group is 615 rows); and **migration `0044_low_pride.sql` (one additive `CREATE INDEX`) has NOT been run on prod**. Live validation was 12 PASS / 1 FAIL, the failure being the filter bar unreachable at 375px — measured identically on the branch base, so pre-existing (MyMind task `9745f72d`). Read-around-a-search-hit stays deferred. Bundle +3,277 B gzip (+0.16%). Previously reconciled 2026-09-19 — **cycle 65 (`/agent` rebuilt on AI Elements) built** (`feat/agent-page-rebuild`, unmerged and unpushed): `/agent` is now two panels with a Rive **Persona** instead of the three.js particle head (the whole avatar/`lib/viz`/bake stack is **deleted** — which closes the cycle-60 "the 3D should be a face" complaint by removal, see §2), an Elements **PromptInput** composer, exec approvals rendered **inline on the tool card** (closing MyMind task `26fc248c` — Stop/new/load now abort the turn *and* deny its pending approvals), and a **context meter** over new `MessageUsage.contextTokens`/`modelDefId` + `ModelDef.contextWindow`. **The branch also carries `modules/tailwind-build-context.ts`, the fix for a production-build OOM that master does NOT have** — the branch's own base OOM'd at deploy.yml's 4096 MB heap, so cycle 64 on local master is a deploy risk until this ships. Live validation found and fixed two real defects (a stuck composer after New-conversation-mid-turn; `?q=` auto-sending before the model override and leaving the question in the box). Previously reconciled 2026-09-19 — **cycle 64 (Agent Elements foundation) built** (`feat/agent-elements-foundation`, unmerged): the `/agent` conversation moved onto AI SDK `UIMessage`s streamed over the voice WebSocket and rendered with AI Elements Vue — tool calls now show live Running/Completed/Error/Denied states with expandable input/output, and a subagent's nested calls render inline instead of collapsing to a count. Cycle 1 of a 4-cycle program; cycles 65–67 (Persona/layout rebuild, `/sessions/[id]`, voice studio + Home) are deferred with MyMind task pointers — see §2 below and the [cycle-64 handover](handovers/2026-09-19-agent-elements-foundation.md). Previously reconciled 2026-08-27 — **cycle 60 (Agent surface redesign) built** (`feat/agent-surface-redesign`, unmerged): four of six agent-page complaints closed, two blocked on a human (the MakeHuman head export and Orpheus on the rig) — see §2 below and the [cycle-60 handover](handovers/2026-08-27-agent-surface-redesign.md). Previously reconciled 2026-08-25 (cycle 59, documents folders). Earlier: 2026-07-15 — **cycle 46 (Session↔Project Reassignment + Path-Based Auto-Routing) built** (`feat/session-project-reassignment`, unmerged): closes the cycle-23 gap where a no-git-remote session with no label match was stuck in `uncategorized` with no way out — reassignment (single/bulk, agent-memory cascade), a learned `path_prefixes` routing column (auto-create + manual reassign both write it), `git_root` label matching, hostname surfacing/filter, and a one-time existing-projects-only re-resolve backfill (not yet run on prod). See [`wiki/sessions.md`](wiki/sessions.md) + [`wiki/projects.md`](wiki/projects.md) + the [cycle-46 handover](handovers/2026-07-15-session-project-reassignment.md). Operational steps, re-checked against prod 2026-08-05: **merged** ✅ and the **Terawulf cluster is drained** ✅ (the `terawulf` project holds 34 sessions with 4 registered `path_prefixes`; uncategorized is down to 23). Whether `scripts/reresolve-uncategorized.ts` itself was run on prod is **not determinable from the data** — the drain could equally be the UI bulk-reassign path. Tracked in §5. Previously reconciled 2026-06-16 — **cycle 13 (Bridget Parity) shipped** (broadened from "API key UI"): API-key CRUD + Connect-to-Claude-Code, capture-fidelity ingestion (tool_events/thinking/git/machine), one-time import of 457 claude_code sessions, session summarization + session/message search, and memory intelligence (provenance + a `memory_relations` graph + LLM relationship-judge with auto-supersede + review-gated contradictions). On `feat/bridget-parity` (not yet merged); closes the §3 session-summarization + bridget-migration items and the session/message-search gap. Earlier: **cycle 22 (Activity Log / Observability) shipped**: a centralized live `activity_log` ledger (inbound + jobs + model-per-attempt + agent tool/reasoning), `/activity` UI with trace-tree detail + ack, severity-tiered prune, and badge/toast/**Resend email** alerts configurable in `/settings`. Stands up Resend (closes the Email item below). See [`wiki/activity-log.md`](wiki/activity-log.md). Remaining: live E2E with the rigs (pending acceptance) + the deferred model request/response body capture. (Cycle 21 Live Reactivity shipped 2026-06-12; its full multi-resource cross-tab E2E sweep is still open.) **Reconciled 2026-06-17 — the entire Projects line shipped + deployed to prod (cycles 23–27):** canonical git-keyed projects + session/memory association (23), sessions UX/SSE (24), projects UI + per-project colour (25), the `/projects/[slug]` **dashboard** + editable-slug cascade (25-followup), **document↔project association** via the `/projects/<slug>/` path invariant + `documents.project_id` (migration 0021) (26), and **project merge** (27). See [`wiki/projects.md`](wiki/projects.md) + the cycle-23→27 handovers.

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
- ~~**The 3D should be a face, not a sphere.**~~ ✅ **CLOSED in cycle 65 — by deleting the feature,
  not by shipping the head.** The whole particle-head stack (`Avatar.client.vue`, `app/lib/avatar/**`,
  `app/lib/viz/**`, `scripts/bake-head.ts`, `scripts/blender-export-head.py`,
  `app/assets/head-points.bin`, the `bake:head` script) is **deleted**, and `/agent`'s face is now a
  Rive **Persona** from AI Elements — state-driven, four variants, a CSS-disc fallback. The old plan
  never completed: it needed a CC0 export from an official, unmodified MakeHuman build (FLAME and the
  Basel Face Model were rejected as research-licence-only), that export was blocked on a human and
  never happened, and Tony had already said he never liked the result — so cycle 65's brainstorm chose
  Persona instead. **The MakeHuman/`bake:head`/`head-points.bin` steps this entry used to prescribe no
  longer exist**; `three` stays in the repo only because Galaxy uses it. See the
  [cycle-65 handover](handovers/2026-09-19-agent-page-rebuild.md).

**New open item from cycle 60's own documentation pass:** `VOICE_TUNING.tts.playbackRate` was moved
1.1 → 1.0 per the spec, but **that constant has no reader** — playback is driven solely by
`VOICE_SETTINGS_DEFAULTS.playbackRate` in `app/composables/useVoiceSettings.ts`, which is **still
1.1**. The audible rate did not change for anyone. One-line fix; **settle it before judging Orpheus
against Kokoro**, or the control in that comparison is not a control.

**Also deferred from cycle 60:** the spec asked for a rename/delete **row context menu on the thread
rail** and the plan assigned it to no task — not built. Nothing is unreachable (both live on
`/agent/history`, which the sidebar now surfaces). Sixteen further deferred minors are itemized in the
handover.

### Agent Elements foundation (cycle 64) — ✅ closed same-cycle; three follow-on cycles deferred with MyMind tasks

Cycle 1 of the "agent surfaces on AI Elements" program (brainstormed 2026-09-18/19). Built on
`feat/agent-elements-foundation` — **BUILT, NOT MERGED**; see the
[handover](handovers/2026-09-19-agent-elements-foundation.md). Closes three gaps raised fresh in that
brainstorm (none were previously tracked in this backlog):
- ~~Tool calls render as a one-line badge after they finish — no running state, no input, no output.~~
  ✅ **closed** — tools now show a live Running → Completed/Error/Denied state with an expandable
  input/output (AI Elements `Tool`).
- ~~Subagent work is invisible — a nested run collapses to "(N tool calls)".~~ ✅ **closed** — a
  subagent's nested tool calls render inline, nested under the parent tool (`ChainOfThought`), live
  and on resume.
- ~~Hand-rolled transcript scroll/markdown plumbing (`Transcript.vue` autoscroll pin, MDC per-entry
  cache keys) keeps breaking.~~ ✅ **closed** — replaced by AI Elements Vue's `Conversation`
  (`vue-stick-to-bottom`) + `vue-stream-markdown`; `Transcript.vue` and `ReasoningBlock.vue` are
  deleted.

**Deferred to the program's next three cycles** (each gets its own spec; this cycle only reserved the
seam) — **all three are now BUILT, and the program is complete:**
- ~~**Cycle 65 — `/agent` rebuild**~~ ✅ **BUILT** (`feat/agent-page-rebuild`, **NOT MERGED, NOT
  PUSHED**) — Persona, the two-panel layout, the `PromptInput` composer, inline `Confirmation`
  approvals (`ApprovalPrompt` deleted), a Context meter, and the avatar/three.js stack retired. MyMind
  task `3ddae408`. See the [cycle-65 handover](handovers/2026-09-19-agent-page-rebuild.md) — and note
  it carries `modules/tailwind-build-context.ts`, **the fix for a prod-build OOM that master does not
  have**.
- ~~**Cycle 66 — `/sessions/[id]`**~~ ✅ **BUILT** (`feat/sessions-elements`, **NOT MERGED, NOT
  PUSHED, NOT DEPLOYED**) — the transcript on the Elements row primitives, plus keyset pagination,
  server-side filters and a measured virtualizer. MyMind task `14d0074b`. See the
  [cycle-66 handover](handovers/2026-09-20-sessions-elements.md) — and note it is the first of the
  three stacked cycles with **a migration to run on prod** (`0044_low_pride.sql`).
- ~~**Cycle 67 — voice studio + Home**~~ ✅ **BUILT** (`feat/voice-studio-refactor`, **NOT MERGED,
  NOT PUSHED, NOT DEPLOYED**) — and **deliberately smaller than the three before it, because
  measuring the deferred line found two thirds of it empty.** **Home was DESCOPED, not deferred:**
  `AskBrain.vue` is 23 lines (a `UInput` that navigates to `/agent?q=` and never sends), and turning
  it into a composer was offered and **declined** — it would add attachments and a model picker to a
  box whose whole job is handing a question to the page that already has both. **"Shared voice
  pieces" turned out not to exist:** `AgentMicBand` is agent-only, `WaveformTrack` studio-only, they
  visualise different quantities, and nothing is duplicated between the surfaces. What shipped
  instead: `DesignPane.vue` **1,101 → 454 lines** split into `DesignDescription` (88),
  `DesignSeedAudition` (301) and `DesignReferenceClip` (332) plus `useRigRender.ts` (59); the speak
  box in composer chrome (`InputGroup` + the Elements footer primitives — **not** the `PromptInput`
  wrapper, whose textarea hardcodes Enter-to-submit); `SettingsSlideover.vue` moved from
  `components/voice/` to `components/agent/`; and **the cycle's one user-visible change, the
  microphone fix** — reference-clip recording called bare `getUserMedia({ audio: true })`, so picking
  a microphone in settings did nothing for the studio while the live agent honoured it. All **9 live
  validation items PASS** against a reachable rig. MyMind task `d321c732` (its title still says
  "+ Home"). See the [cycle-67 handover](handovers/2026-09-20-voice-studio-refactor.md) — **no
  migration, and no server code touched at all.** **This completes the four-cycle program**, and
  leaves the merge/push backlog (90 commits, four stacked cycles) as the repo's largest open risk.

**Operational note carried forward, not introduced this cycle:** the dev reasoning chain's head
(qwen @ `192.168.2.25:8004`) is down, and `runAgent` does not fail over on a stream-open connect
error — a turn fails rather than falling back to the chain's next entry unless the `/agent` toolbar's
model picker is used to move a reachable model to the front. Subagents (`research_web`/`search_brain`)
always run the default chain and do **not** inherit the picker's connection-level override, so a
subagent's nested tool calls cannot be exercised live while the chain head is down — this is a
pre-existing model-availability gap, not a cycle-64 rendering defect (see the handover's live-validation
item 2).

### `/agent` rebuild (cycle 65) — ✅ built; the face complaint closed by deletion

Cycle 2 of the "agent surfaces on AI Elements" program. Built on `feat/agent-page-rebuild` —
**BUILT, NOT MERGED, NOT PUSHED**; see the
[handover](handovers/2026-09-19-agent-page-rebuild.md). What it closes:
- ~~**The 3D should be a face, not a sphere** (cycle-60 complaint, above).~~ ✅ closed **by removing
  the particle head**, not by shipping it — replaced with a Rive Persona. Details in §2's cycle-60
  block.
- ~~**Exec approvals render as a detached banner; the tool just says Running**~~ (raised in cycle 64's
  live validation). ✅ closed — the approval rides the message stream as the SDK's own
  `tool-approval-request` chunk and renders as an Elements `Confirmation` inside the tool card.
- ~~**The approval banner outlives Stop; the server's `new` doesn't abort the running turn**~~ —
  MyMind task `26fc248c`. ✅ closed — `interrupt`, `new` and `load` all abort the turn **and** deny
  every pending approval (`denyPendingApprovals()`); the next message now starts in ~4 s instead of
  waiting out the 120 s approval timeout.
- ~~**No visibility into how full the model's context is.**~~ ✅ closed — a context meter in the
  composer, over new `MessageUsage.contextTokens`/`modelDefId` and `ModelDef.contextWindow`.

**Open, carried out of cycle 65:**
- **`modules/tailwind-build-context.ts` is on this branch only, and master needs it.** The branch's
  own base commit OOM'd the 4096 MB production build, so cycle 64 on local master is a live deploy
  risk. Merge/push order matters: this fix should land with or before cycle 64.
- **Nuxt Icon's server bundle ships `simple-icons`' 4.6 MB JSON unused** — limiting the bundle to
  `lucide` was measured at −105 MB of build memory and not applied. Its own follow-up.
- **`obsidian`, the default Persona variant, is very pale in light mode** (measured mean luminance
  0.911 against an off-white page — visible, but the weakest of the four). `mana`/`opal` read better.
  A one-line default change, worth a look with Tony.
- **Subagents still don't inherit the composer's model override** (MyMind task `6c72627d`) — a
  deliberate cycle-45 boundary, explicitly out of scope in cycle 65's spec, and still the reason a
  subagent can't be exercised live while the dev chain head is down.
- Assorted deferred minors (duplicated model zod shape, untested `ws.ts` approval wiring, an empty
  context-hovercard body, and ~10 more) are itemized in the handover's `deferred:` block.

### `/sessions/[id]` on AI Elements (cycle 66) — ✅ built; one feature deliberately still deferred

Cycle 3 of the "agent surfaces on AI Elements" program. Built on `feat/sessions-elements` —
**BUILT, NOT MERGED, NOT PUSHED, NOT DEPLOYED**; see the
[handover](handovers/2026-09-20-sessions-elements.md). What it closes (all three raised by the owner
at brainstorm, none previously tracked here):
- ~~**Tool calls are unreadable** — a badge plus `args`/`result` truncated to 500 characters of raw
  JSON in a `<pre>`.~~ ✅ closed — each tool event is an Elements `Tool` card (name, exit-status
  badge, expandable input/output) via a pure, unit-tested `sessionToolState` adapter.
- ~~**There is no filtering** — one flat stream including 5,099 sidechain messages, with no way to
  narrow by tool or find text.~~ ✅ closed — three **server-side** filters (hide subagent, by tool
  name, find-in-session), sharing one `applyMessageFilters()` with the live-tail delta so the two
  cannot drift.
- ~~**The whole session loads at once** — every message and every tool event in one query, however
  large.~~ ✅ closed — keyset pages of 100 (capped at 200) over a `(created_at, id)` cursor, each
  carrying only its own messages' tool events. `@tanstack/vue-virtual` measures rows instead of
  guessing 140px; anchoring on prepend measured at **0px drift across ten consecutive pages** of a
  4,760-message session.

**Open, carried out of cycle 66:**
- **Migration `0044_low_pride.sql` has not been run on prod.** One additive `CREATE INDEX` on
  `messages`; safe online, but without it every keyset page over a large session is a sequential
  scan. It must run with or before the deploy.
- **Ordering changed for 26% of rows.** Adding `id` as the `created_at` tiebreak is a correctness
  fix (58,417 of 228,692 messages share a timestamp; the largest tie group is 615 rows) but it
  **visibly changes** the rendered order inside tie groups. Expect it; the old order was
  unspecified, not correct.
- **Read-around-a-search-hit is still deferred** — landing on a message from global search and
  loading N before/after it is a different cursor mode. `q` narrows the transcript to matches
  instead, which does not show the hit in context. The real gap of this cycle.
- **At 375px the metadata panel squeezes the transcript to 0px**, so the filter bar is unreachable
  on mobile — MyMind task `9745f72d`. Pre-existing cycle-24 split-pane behaviour, measured
  identically on the branch base; the new filter bar just gives it something new to hide.
- **The per-turn `model` label and the per-message metadata collapsible were lost in the row
  rewrite** and were not on the spec's deletion list. `SessionMessageDTO` still carries both fields,
  so restoring them is template-only.
- **The live-tail delta still orders `created_at ASC` with no `id` tiebreak**, unlike every paged
  query. Small exposure (it appends a few rows at the tail and is not paginated), recorded because
  the spec's "every query orders by `(created_at, id)`" reads as universal and is not.
- **A committed `.githooks/commit-msg` rejecting `Co-Authored-By` / model-name trailers** — raised
  for the second cycle running, still not built. Subagents committed a trailer twice this cycle
  (caught both times) because the harness instructs it and the global CLAUDE.md overrides it, so
  every dispatch re-wins the same conflict. Ten minutes, structural.
- Assorted deferred minors (a dead `vi.mock('h3')` block, no `scrollMargin` on the top sentinel,
  `pnpm test:db -- <path>` not isolating to one file, and ~6 more) are itemized in the handover's
  `deferred:` block.

### Agent chat affordances (cycle 68) — ✅ built; cycle 28's branching deferral is CLOSED

Built on `feat/chat-affordances` — **BUILT, NOT MERGED, NOT DEPLOYED**, but cut from a **deployed**
baseline; see the [handover](handovers/2026-09-21-agent-chat-affordances.md). What it closes:

- ~~**"No copy message button" / "missing lots of stuff"**~~ — ✅ closed, and the finding is
  that **they were never missing**. Copy, regenerate, the timestamp and a token count already lived
  in `ReplyActions.vue` behind `opacity-0 group-hover:opacity-100 focus-within:opacity-100`:
  discoverable only by accident on a desktop, and **unreachable by any gesture on a touch device**.
  The fix was deleting a CSS class. The row is now always visible and wraps rather than overflowing
  at 375px.
- ~~**"No fork conversation at message"**~~ — ✅ closed, along with the whole branching model.
- ~~**Branching UI (edit/regenerate → fork) — deferred by cycle 28, which reserved
  `conversation_messages.parent_id` and then left it written linearly and READ BY NOTHING.**~~
  ✅ closed — `conversations.active_leaf_id` plus one shared `loadActivePath` that **both** read
  paths use, sibling-derived `‹ n/N ›` pagers, and fork/edit/regenerate as one server-side
  primitive. This also retires the "Branching UI" bullet in [`wiki/agent.md`](wiki/agent.md)'s
  Deferred list.
- ~~**No per-turn speed figure** ("surface some performance metrics like tok/s on each agent message
  so that we can monitor speed").~~ ✅ closed — `startedAt`/`ttftMs`/`durationMs` on the message's
  existing `usage` jsonb, rendered **live during the turn**, not only after a reload.

**Open, carried out of cycle 68:**

- **Migration `0045_busy_solo.sql` has not been run on prod** — one additive `ADD COLUMN` plus a
  self-healing backfill. Safe to re-run, but load-bearing: until it runs, every conversation has a
  null leaf and every read takes the flat fallback — correct, but with **no branching at all**.
  After it runs, check the invariant it exists to establish: no conversation's `active_leaf_id` may
  have a child (0 on dev, across all 16 conversations).
- **Retry is no longer destructive, which is a behaviour change.** It used to truncate the thread
  from the retried turn onward; it now branches and keeps the previous reply. Anyone expecting
  "retry replaces the answer" will be surprised. `app/lib/agent/retry.ts` and its test are deleted.
- **The first turn of a thread cannot be edited or regenerated** (Ruling 22). `branchParent`'s null
  is ambiguous — "this is a root" and "not found" — and `active_leaf_id = null` already means "fall
  back to a flat read". The endpoint now says so honestly rather than claiming the message is not in
  the conversation. **Owed a MyMind task.**
- **The concurrent-writer race on the leaf is parked, not fixed** (Rulings 8/9). It predates this
  cycle, and branching makes its consequence recoverable (a surprise branch you can page to) rather
  than silent (an unreadable orphan). The inserts and the leaf move *were* made atomic, because that
  failure mode is one this cycle creates. **Owed a MyMind task.**
- **`message_count` counts every row in the tree**, inactive branches included, so a branched
  thread's rail count legitimately exceeds what is displayed (Ruling 3, spec-stated). Out of scope
  with it: branches on the thread rail, delete/merge/rename a branch, per-branch counts.
- **`rateLabel` is knowingly inaccurate for a tool-calling turn** — tool wait time sits inside the
  measured window, so such a turn reads slower than the model generated. Stated in the code, the
  wiki and the handover; `durationLabel` sits beside it so a low figure is attributable.
- **`ws.ts` still has no test file at all.** The leaf capture was extracted and DB-tested precisely
  because of that; the wiring inside `ws.ts` is verified by reading, typecheck and the browser.
- **A committed `.githooks/commit-msg` rejecting `Co-Authored-By` / model-name trailers — now raised
  for the THIRD cycle running.** It slipped in once here (caught, amended, verified by reflog). The
  cause is structural: the harness instructs those lines and the global CLAUDE.md overrides it, so
  every dispatch re-wins the same conflict.

### Memory applicability + context assembler (cycle 70) and slash commands (cycle 71) — 🔨 built, NOT merged

Both shipped on `worktree-cycle-70-memory-assembler`; migrations 0046–0052 are applied to **DEV only**. Tracked as one MyMind task ("Cycles 70+71 follow-ups"). Handovers: [`2026-09-24-memory-applicability-context-assembler.md`](handovers/2026-09-24-memory-applicability-context-assembler.md), [`2026-09-24-slash-commands.md`](handovers/2026-09-24-slash-commands.md).

Deferred, in rough order of how much they cost to leave open:

- **`turns` is never passed to `assembleContext`**, so the budget's turn-eviction path is built, tested and unreachable. The assembler works; the half that makes it *budgeted* under load does not run.
- **`/review` has no handler for the three new concern kinds** (contradiction, resident nomination, applicability) — they enqueue fine and then 400 on approve.
- **`conversations.summary` has no writer.** The summary tier reads a column nothing populates, so that tier is always empty.
- **`contextEpochAt` never reaches `ConversationDTO`**, so `/clear`'s epoch divider does not survive a reload: the user sees pre-clear messages the model cannot, with nothing marking the boundary.
- Conversation enrichment should route through `resolveEnrichedMemory` rather than its own path.
- **No UI for `prompt_commands`** — rows are insert-only via SQL. The table, service and precedence merge are built and tested; a settings screen is the next slice.
- `capSkillBody` trims head+tail, so a long skill that puts its steps in the middle loses them. Nothing is near the 8000-char cap today.
- **`.db.test.ts` constant-embedding hazard:** the suites stub `$fetch` to one fixed vector, so `createMemory` silently merges any two rows sharing `(scope, project)`. Tests needing distinct rows must insert directly — worth a harness fix rather than a per-test workaround, since the failure looks like a missing row, not a merge.

Two process lessons worth keeping, both paid for in fix rounds:

- **Browser-validate at the task that builds the UI, not at end-of-cycle wrap-up.** Cycle 71's `/` menu passed two code reviews and two fix rounds while rendering *nothing* — every review reasoned about the diff, and the suite was green throughout. It was caught only because the next task's implementer happened to look at the page.
- **"Already vendored" is not "fits".** Three of those rounds went to shadcn's `Command` wrapper, which gates item visibility on a `filterState` only `CommandInput` populates — and the composer's own textarea *is* the input, so mounting it was never an option. A plain `<ul>` worked first try.

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
