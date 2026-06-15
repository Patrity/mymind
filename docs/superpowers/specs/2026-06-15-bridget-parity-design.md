---
title: API Keys, Claude Code Connect & Bridget Parity (Sessions + Memory Intelligence)
date: 2026-06-15
status: spec
cycle: 13
supersedes: null
related:
  - docs/superpowers/specs/2026-06-03-memory-mcp.md
  - docs/superpowers/specs/2026-06-03-sessions-view.md
  - docs/superpowers/specs/2026-06-12-live-reactivity-design.md
  - docs/wiki/mcp.md
  - docs/wiki/memory.md
  - docs/wiki/sessions.md
---

# API Keys, Claude Code Connect & Bridget Parity

## Why this cycle exists

Two threads converged. (1) Machine tokens (`api_tokens`) are inserted by hand — there's no UI to
mint/list/revoke, and no shipped client to actually wire Claude Code into MyMind. (2) An audit of
the system MyMind is replacing — the bridget memory service (`~/Documents/GitHub/bridget-services/memory`)
+ command-center webapp — found that MyMind's **shipped** session ingestion and enrichment are
materially lower-fidelity than bridget's, and that two whole bridget capabilities (session
summarization, session/message semantic search) don't exist in MyMind at all. The moment Tony
points his CC hooks at MyMind, every new session would be captured at reduced fidelity, and that
data is unrecoverable.

Decision (Tony, brainstorm): **full parity in one cycle.** Plus two directives:
- **Migrate raw data only** — import bridget's `sessions`/`messages`/`tool_events`, NOT its
  memories. MyMind re-enriches locally. (This also sidesteps bridget's truncated-`content_hash`
  format mismatch — no memory rows are copied.)
- **Memory lifecycle is a first-class deliverable** — bridget tracks provenance and
  dedup poorly and never models supersession/contradiction. MyMind will do better.

This spec fulfills roadmap **cycle 13** (API key UI) and folds in the backlog items
*session-summarization worker*, *bridget data migration*, and *session/message semantic search*,
plus net-new **memory-intelligence** scope.

## What MyMind already replaces faithfully (no work needed)

Confirmed by audit — do **not** rebuild these: the memory model (`scope`/`project`/`session_id`/
`enriched_at`/`reviewed_at`/`confidence`/`evidence`/`content_hash`, `halfvec(2560)`), two-stage
dedup (`server/services/memory-dedup.ts`: exact-hash→skip, cosine≥0.85→merge, evidence-append,
23505 race handling), RRF hybrid memory search + optional reranker + auto-review threshold,
two-tier ingestion (event upserts session / transcript writes messages), idempotency keys, and
enrichment running **on the scheduler** (`enrich-memories */15` — bridget's never ran
automatically).

## Goals

1. Mint/list/revoke tokens from `/settings`; copy-paste a complete Claude Code setup (MCP + hooks)
   that begins ingestion, with secret-free snippets.
2. Capture sessions at **full bridget fidelity** so switching hooks loses nothing: tool events,
   thinking, sidechain, model/stop-reason/parent, and session git/machine/app metadata.
3. Generate session **titles + summaries** and make sessions **and messages** semantically
   searchable.
4. Improve enrichment: better candidate selection, richer prompt/payload, project inheritance, and
   a **memory-lifecycle layer** — rich provenance + a relationship graph with auto-resolved
   refinements and review-gated contradictions.
5. One-time import bridget's raw session data; re-enrich it locally.

## Non-goals (YAGNI)

- Per-token scopes; `userId`/multi-user; token expiry/regenerate.
- Auto-patching the user's `settings.json`/`.mcp.json` (no pipe-to-bash installer).
- Importing bridget's `mem_entries` (memories) — explicitly excluded.
- Porting bridget's local file-tail worker (`cc_tail.py`) — MyMind ingests via the HTTP hook only.
- iMessage ingestion (separate bridget service; out of scope).

## Locked decisions (brainstorm)

- **No token scopes**; management endpoints are **session-only** (reject `api-token` clients).
- **Transcript shipping = byte-offset delta**; Connect helper lives on the **API Keys tab**; token
  delivered via two env vars (`MYMIND_URL`, `MYMIND_TOKEN`) so snippets are secret-free.
- **Soft-revoke** tokens (keep the row).
- **Conflict policy = auto-resolve + review fallback**: an LLM relationship-judge classifies
  near-duplicates; duplicates merge, high-confidence **refinements auto-supersede** (old archived +
  linked), **contradictions and low-confidence calls route to the review queue**.
- **Provenance = rich + relationship graph**: per-memory `session_id` + contributing `msg_ids` +
  verbatim quote + extractor reasoning, plus a `memory_relations` edge table
  (`supersedes`/`contradicts`/`duplicate-of`).

---

# Part A — API Key Management

**Schema** (migration): add `last_four text` (nullable) to `api_tokens` — non-secret display hint
(last 4 chars of the minted token) so the list shows `mm_…AbCd`. No scopes, no `userId`.

**Service** `server/services/api-tokens.ts`:
- `listTokens()` → `{ id, name, lastFour, createdAt, lastUsedAt, revokedAt }[]` — never the hash.
- `createToken(name)` → `generateToken()` (existing) → store `hashToken()` + `lastFour` → returns
  DTO + one-time plaintext `token`. Never persisted/logged.
- `revokeToken(id)` → soft-revoke (set `revoked_at`), idempotent; 404 on unknown id.
- Each mutation `publishChange({ resource:'apiToken', action, id })`.

**API** `server/api/settings/tokens/{index.get,index.post}.ts` + `[id]/revoke.post.ts`. All three
**require a session** via a new `requireSession(event)` guard (`server/utils/auth-guard.ts`),
rejecting `event.context.client.type === 'api-token'` with 403.

**Live**: add `'apiToken'` to `ResourceName` (`shared/types/live.ts`) + dispatch entry
(`app/utils/live-dispatch.ts`) invalidating the list.

**UI** `app/components/settings/ApiKeysTab.vue` (5th `UTabs` slot in `settings.vue`), `useApiTokens()`
vue-query composable. List (Name · `mm_…lastFour` · Created · Last used · Active/Revoked · Revoke);
Create → `UModal` name field → success shows plaintext in a copyable `UAlert color="warning"`
("copy now, you won't see it again") which also seeds Part B's Connect blocks with the real token.

---

# Part B — Connect to Claude Code

**Hook client `cc-hook.sh`** (new artifact; ports bridget's `bridget-cc-hook` to MyMind's contract):
1. Read CC hook JSON from stdin → `session_id`, `cwd`, `hook_event_name`, `transcript_path`.
2. Resolve `MYMIND_URL`/`MYMIND_TOKEN` from env, falling back to `~/.mymind/config.env`.
3. Gather local context the JSONL lacks: `git -C "$cwd"` branch/commit/remote (2s timeout, never
   fail), `hostname`, a stable `machine_id` (`~/.mymind/machine_id`, generated once).
4. **Always** POST the event to `${MYMIND_URL}/api/hooks/cc/${event}` with `Authorization: Bearer`
   and body `{ source:'claude_code', external_id, project, cwd, git_branch, git_commit, git_remote,
   machine_id, hostname, app_version, ended_at?, metadata }`.
5. On `Stop`/`SubagentStop`/`SessionEnd`: ship the transcript **byte-offset delta**
   (`~/.mymind/transcript-offsets/<session_id>.off`; read new bytes, cap, advance to last whole
   line, advance offset only on 2xx; reset on rotation) → POST `{ source, external_id, lines:[…] }`
   to `/api/hooks/cc/transcript`.
6. **Never blocks the agent** — all failures logged to `~/.mymind/cc-hook.log`; always `exit 0`.

Served at **`GET /api/setup/cc-hook.sh`** (non-secret text; `/api/setup` added to the auth
middleware `PUBLIC_PREFIXES`) so install is `curl … -o ~/.mymind/cc-hook.sh && chmod +x`. The
script body is a versioned server asset (single source of truth with the displayed snippet).

**Connect UI** (section on the API Keys tab; host from `BETTER_AUTH_URL`; copy buttons):
- **Step 1 — token** (real values only in the mint-success state; placeholder otherwise):
  `export MYMIND_URL=… MYMIND_TOKEN=mm_…` (+ append to `~/.mymind/config.env`).
- **Step 2 — MCP**: `.mcp.json`/`~/.claude.json` block using `${MYMIND_TOKEN}`/`${MYMIND_URL}`
  expansion **and** the `claude mcp add --transport http --scope user …` one-liner.
- **Step 3 — hooks**: the `curl` install line + a `~/.claude/settings.json` `hooks` block wiring
  `command`-type hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionEnd`)
  to `~/.mymind/cc-hook.sh <Event>`. Exact event set/casing + stdin field names re-verified against
  installed Claude Code at build time (rely only on the well-established `command` hook + `.mcp.json`
  `http` transport; ignore speculative hook types).

**Endpoint changes**: `/api/hooks/cc/[event]` accepts + persists the new session fields (§Part C);
`/api/hooks/cc/transcript` is unchanged in shape (raw `lines`) — the richer parser does the work.

---

# Part C — Capture fidelity

The audit's irreversible-loss gaps. Schema + parser + endpoint.

**`messages` table — add columns** (migration): `thinking text`, `model text`, `stop_reason text`,
`request_id text`, `parent_uuid text`, `is_sidechain boolean not null default false`, `usage jsonb`,
`embedding halfvec(2560)` (Part E). Keep existing `metadata` jsonb for anything else.

**`tool_events` table — new** (mirrors bridget): `id uuid pk`, `session_id uuid` (idx),
`message_id uuid` (the parent assistant message), `tool_name text not null`, `args jsonb`,
`result jsonb`, `exit_status text` (`ok|error|timeout|cancelled`), `phase text not null default
'completed'` (`pre|completed|failed`), `tool_use_id text`, `is_sidechain boolean not null default
false`, `caller_type text`, `created_at timestamptz`. **Partial-unique `(session_id, tool_use_id)
WHERE tool_use_id IS NOT NULL`** for idempotency. Indexes `(session_id, created_at)`, `tool_name`.

**`sessions` table — add columns**: `machine_id text` (idx), `hostname text`, `git_branch text`,
`git_commit text`, `git_remote text`, `app_version text`, `ended_at timestamptz`,
`summary_embedding halfvec(2560)` (Part D), `last_embedded_at timestamptz`.

**Parser rewrite** `server/services/transcript-parse.ts` (still pure, never throws) — match
bridget's `_process_line` fidelity:
- Extract `thinking` from `type:'thinking'` blocks (separate from visible text).
- For each `tool_use` block → emit a tool-event record (`tool_name`, `args`=input, `tool_use_id`,
  `caller_type`, `phase:'pre'`); for each `tool_result` block → a tool-event *update*
  (`result`, `phase:'completed'|'failed'` + `exit_status` from `is_error`), matched by
  `tool_use_id`.
- **`pure_tool_result` skip**: a user line that is only a tool_result (no text/tool_use) does NOT
  produce a message row, but its tool_result still closes the tool-event.
- **system-prompt heuristic**: user line, no `uuid`, text > 200 chars → `metadata.system_prompt=true`
  (kept, but filterable).
- Per-message fields: `external_uuid`=`uuid`, `parent_uuid`, `model`, `request_id`, `stop_reason`,
  `usage` (jsonb), `is_sidechain` (line `isSidechain`, falling back to a batch default), `created_at`
  from the line `timestamp`.
- Return `{ messages, toolEvents, inputTokens, outputTokens }` (toolEvents joined to their parent
  message after insert).

**`ingestTranscript`** rewrite: insert messages idempotently (existing key), then insert/close
tool_events idempotently; recompute `message_count` (excluding `system_prompt` + pure tool rows),
`tool_count` from `tool_events`, token totals, and `started_at`/`last_active` from message
min/max `created_at` (bridget recomputes these; today MyMind doesn't). `upsertSession` extended to
persist the new git/machine/app/ended fields from the event payload.

**Sessions view** (`app/pages/sessions/[id].vue` + DTOs): add a **Tool Events** tab (name, args,
result, exit-status badge, phase), surface thinking (collapsible), and the new header fields
(git branch@commit, machine, app version, ended). Mirrors bridget's command-center detail.

---

# Part D — Session summarization worker

Port bridget `sess_summarize`.

**State table `sess_summary_state`** (new): PK `session_id` (cascade), `last_summarized_message_count
int default 0`, `last_run timestamptz`, `status text` (`ok|skipped|error`), `error text`,
`duration_ms int`, `model text`, `summary_chars int`, `title_chars int`, timestamps.

**Task `summarize-sessions`** (scheduler, e.g. `*/5`): selector buckets (retry-errors → never-
summarized → grew-by-≥N → stale-by-time) over sessions meeting a real-message floor; build a
transcript (thinking wrapped, one-line tool summaries, head/tail elision over a char cap); call
`chat('reasoning', …)` (or a dedicated `summary` usage if assigned) for strict JSON
`{title, summary}`; **`title = COALESCE(NULLIF(model_title,''), existing_title)`** (never clobber a
manual title); store `summary` + `summary_embedding` (embedded before the txn, non-fatal on
failure) + `last_embedded_at`; upsert state. Prompt: neutral past-tense changelog voice; title
≤100 chars topical/imperative; summary 3-6 sentences (intent, decisions, concrete artifacts, open
next step). `publishChange({resource:'session', action:'updated', id})`.

---

# Part E — Session & message semantic search

**Embeddings**: `messages.embedding` filled by a worker (extend the existing `embed-documents`
task or add `embed-messages`; MIN/MAX char guards like docs); `sessions.summary_embedding` filled
by Part D.

**Services**: `searchSessions(q)` — RRF over trigram (`title`/`summary`) + vector
(`summary_embedding`); `searchMessages(q)` — RRF over trigram (`content`) + vector (`embedding`),
both `k=60`, mirroring `searchMemories`/`searchDocs`.

**Wire into search**: add `session` + `message` kinds to the unified/command-palette search
(`server/api/search/**` + the palette UI), each linking to `/sessions/{id}` (messages deep-link to
the parent session). Optional: a search box on the sessions list page.

---

# Part F — Enrichment tuning

Harden `server/services/memory-enrich.ts` to bridget quality (on the captured-fidelity data):
- **Selector**: real-message floor (exclude sidechain + empty + `system_prompt`), a **grace period**
  (`last_active < now() - grace`, so still-active sessions aren't chewed), growth-since-last `≥ N`
  (not *any* growth), exclude inactive/archived projects, and **retry errored sessions after 24h**
  (today an error advances the watermark and never retries).
- **Payload**: include `thinking` (capped), a tool-usage summary (from `tool_events`), exclude
  sidechain + `system_prompt` messages, head/tail message truncation.
- **Project inheritance**: pass the session's `project` into `createMemory` (today omitted → all
  enrichment memories land in the global dedup bucket).
- **Prompt**: expand to bridget quality — atomicity, scope guidance ("agent is the most common
  scope"), confidence bands (drop `<0.3`), volume guidance, and require `evidence_msg_ids` +
  `reasoning` + a short verbatim `quote` per memory (feeds Part G provenance).

---

# Part G — Memory intelligence (provenance + relationship graph)

The net-new design. Bridget has none of this.

**Schema**:
- `memories` — add `superseded_by uuid` (denormalized convenience pointer, nullable). Provenance
  lives in the existing `evidence` jsonb, now an array of richer entries
  `{ sessionId, msgIds, quote, reasoning, mergedAt }`.
- **`memory_relations` table** (new): `id uuid pk`, `from_id uuid` (the newer/superseding memory),
  `to_id uuid` (the older/affected memory), `type text` (`supersedes|contradicts|duplicate-of`),
  `confidence real`, `status text` (`active|resolved`), `reason text` (judge reasoning),
  `created_at`, `resolved_at`. Indexes on `from_id`, `to_id`, `type`. Contradictions are `active`
  until a human resolves them; supersessions are `active` once applied.

**Relationship-judge** `server/lib/ai/memory-judge.ts`: given a new candidate + the cosine-near
existing memories already fetched in `createMemory`, `chat('reasoning', …)` returns
`[{ existingId, relation: 'duplicate'|'refines'|'contradicts'|'unrelated', confidence, reasoning }]`.
Runs in the **enrichment write path only** (bounded token cost); manual MCP/REST `save_memory` keeps
the cheap hash/cosine dedup.

**Resolution** (extends, doesn't replace, `dedupDecision`):
- `duplicate` → merge evidence into existing (current behavior) + optional `duplicate-of` edge.
- `refines`, confidence ≥ auto-threshold → insert new; create `supersedes` edge (new→existing);
  archive existing (`archived_at` + `superseded_by = new`); publish.
- `refines`, confidence < threshold → insert new (active) + enqueue review (`kind:'memory-supersede'`)
  with the proposed supersession; existing stays active until resolved.
- `contradicts` → insert new (active); create `contradicts` edge (`status:'active'`); enqueue review
  (`kind:'memory-contradict'`); both kept, flagged.
- `unrelated` → insert fresh.

**Review queue**: reuse the existing generic `review_queue` (`docId` = the existing memory's id,
`kind` ∈ {`memory-supersede`,`memory-contradict`}, `proposed` = the conflict payload). The review UI
dispatches by `kind`; resolving a conflict applies the chosen outcome (accept supersession /
keep-both / archive one / edit) and sets the relation `status='resolved'`. *(Wart: the column is
named `doc_id`; here it holds a memory id. Acceptable for now; a later generalize-to-`subject_id`
rename is a minor follow-up, not in scope.)*

**Provenance UI**: the memory detail/card surfaces source session (link to `/sessions/{id}`),
contributing messages (deep-link), the verbatim quote + reasoning, and the relationship edges
(supersedes / superseded-by / contradicts) with links. Live via the existing `memory` resource.

---

# Part H — Raw data migration (one-time)

Script `scripts/migrate-bridget-sessions.ts` (run manually, idempotent, **no memories**):
- Connect to bridget's Postgres via a `BRIDGET_DATABASE_URL` env (read-only).
- Copy `sess_sessions` → `sessions`, `msg_messages` → `messages`, `tool_events` → `tool_events`,
  mapping bridget columns to MyMind's (incl. the Part C additions). Preserve `external_id`/
  `external_uuid`/`tool_use_id` so MyMind's idempotency keys hold (re-runnable; future live hook
  ingestion of the same sessions de-dups cleanly).
- Bring **all sources** by default (`claude_code`, `hermes`, `imsg`, …) — it's raw data; a
  `--source` filter is available.
- Do **not** touch `mem_entries`. After import, the `enrich-memories` task (Part F) regenerates
  memories locally over the imported sessions, and `summarize-sessions` (Part D) backfills titles.
- Recompute denormalized counts + `started_at`/`last_active` after import.

---

## Migrations (anticipated, from `0015`)

`api_tokens.last_four`; `messages` new columns + `embedding`; `tool_events` table; `sessions` new
columns + `summary_embedding`; `sess_summary_state` table; `memories.superseded_by`;
`memory_relations` table. The plan sequences exact numbers/files.

## Error handling

- Token: empty name → 400; revoke unknown → 404, already-revoked → idempotent; management endpoint
  via bearer → 403; plaintext only in the create response, never logged.
- Hook script: every failure → log + `exit 0`.
- Parser/ingest: tolerant (skip unparseable lines), idempotent inserts, per-line exceptions
  swallowed so one bad line never poisons a batch.
- Enrichment/judge/summarize: per-session isolation; failures recorded in state; the judge falls
  back to plain `dedupDecision` if the LLM call fails (never blocks a memory insert).

## Testing

- **Unit**: `api-tokens` service (plaintext↔hash, lastFour, list omits hash, idempotent revoke);
  `requireSession`; the new parser (thinking, tool_use/tool_result→events, pure_tool_result skip,
  system_prompt heuristic, sidechain, idempotency); `memory-judge` outcome mapping
  (duplicate/refines-auto/refines-review/contradicts/unrelated → correct writes + edges + queue);
  summarizer title-preservation; session/message search RRF ordering.
- **E2E (`playwright-cli`)**: mint token → copy → use as bearer (200) + MCP `tools/list` (ok) →
  revoke → 401; management endpoints reject a bearer (403). Pipe sample CC payloads to `cc-hook.sh`
  → session row + messages + tool events appear; second Stop with no new bytes → no dup. Summarize
  → title/summary populate; search finds a session and a message. Enrich a session with a
  contradicting fact → a review item appears; a refinement → old memory archived + linked.
- **Migration**: dry-run row counts vs bridget; re-run is a no-op (idempotency).

## Docs / wiki

- New `docs/wiki/api-tokens.md` (token model + Connect recipe). Update `docs/wiki/sessions.md`
  (tool events, summaries, search, new fields), `docs/wiki/memory.md` (provenance + relationship
  graph + judge + tuned enrichment), and cross-link `docs/wiki/mcp.md`.
- On ship: update roadmap cycle 13 row (broadened scope) + tick the folded backlog items
  (session-summarization, bridget migration, session/message search) in `docs/BACKLOG.md`.

## Suggested build phases (for the plan)

1. Part A + B (tokens + Connect) — self-contained, immediately useful.
2. Part C (capture fidelity) — schema + parser + endpoint + sessions view. **Gate before switching
   hooks.**
3. Part H (raw migration) — once C's schema exists, import bridget data.
4. Part D + E (summaries + search) — additive, backfill over imported data.
5. Part F + G (enrichment tuning + memory intelligence) — the net-new layer, last.
