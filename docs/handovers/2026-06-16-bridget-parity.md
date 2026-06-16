---
title: Bridget Parity — API Keys, Connect, Capture Fidelity, Import, Summaries/Search, Memory Intelligence
cycle: 13
date: 2026-06-16
status: shipped
branch: feat/bridget-parity
spec: ../superpowers/specs/2026-06-15-bridget-parity-design.md
plans:
  - ../superpowers/plans/2026-06-15-bridget-parity-phase1-tokens-connect.md
  - ../superpowers/plans/2026-06-15-bridget-parity-phase2-capture-fidelity.md
  - ../superpowers/plans/2026-06-15-bridget-parity-phase3-import.md
  - ../superpowers/plans/2026-06-16-bridget-parity-phase4-summaries-search.md
  - ../superpowers/plans/2026-06-16-bridget-parity-phase5-memory-intelligence.md
wiki:
  - ../wiki/api-tokens.md
  - ../wiki/sessions.md
  - ../wiki/memory.md
shipped:
  - "PHASE 1 — API key management UI + Connect-to-Claude-Code. `api_tokens.last_four`; `server/services/api-tokens.ts` (list/mint/revoke, soft-revoke); session-only endpoints `/api/settings/tokens` (a leaked machine token can't manage tokens → 403); `apiToken` live resource; `/settings → API Keys` tab (mint-once reveal, revoke, Connect snippets). A versioned hook client `server/assets/setup/cc-hook.sh` served (public, secret-free) at `GET /api/setup/cc-hook` (Nitro serverAssets, coerced to utf-8); posts session events + transcript byte-offset deltas, gathers git/machine context, always exits 0. Snippets carry no secret (token in `MYMIND_URL`/`MYMIND_TOKEN` env). Wiki: `api-tokens.md`."
  - "PHASE 2 — Capture fidelity (the data-loss gate). Migration 0016: `tool_events` table + message cols (thinking/model/stop_reason/request_id/parent_uuid/is_sidechain/usage) + session cols (machine_id/hostname/git_branch/git_commit/git_remote/app_version/ended_at). Parser rewritten (`transcript-parse.ts`) to extract thinking + emit tool events (tool_use→tool_result correlation), pure-tool-result skip, system-prompt heuristic; `ingestTranscript` persists them + recomputes aggregates from the real tables; the `[event]` hook persists git/machine/app/ended; sessions detail surfaces thinking (collapsible), tool events (args/result/exit-status), git/machine header, model label, sidechain dimming."
  - "PHASE 3 — One-time raw bridget import. `server/lib/migrate/bridget-map.ts` (pure mappers, drop embeddings/token_count/duration_ms) + `scripts/migrate-bridget-sessions.ts` (per-session import w/ id-remapping, idempotent, --dry-run/--source/--limit, jsonb-safe, recompute aggregates, auto-retarget to the `bridget` db, skip empty sessions). **Imported 457 claude_code sessions / 96,721 messages / 42,428 tool events** into the LOCAL DEV db (all tool events message-linked). Hermes NOT imported (Tony's call; `--source=hermes` adds it). Memories NOT imported — regenerated locally."
  - "PHASE 4 — Session summaries + session/message search. Migration 0017: `sessions.summary_embedding`/`last_embedded_at`, `messages.embedding`, `sess_summary_state` + hand-appended HNSW/trigram indexes. `summarize-sessions` task (*/5, `session-summarize.ts`): selects new/stale/grown sessions, `chat('reasoning')` → strict-JSON title+summary, title-COALESCE, `summary_embedding`. `embed-messages` task (*/4). `searchSessions`/`searchMessages` (RRF trigram+vector) wired into `searchAll` + the command palette (Sessions + Messages groups, message hits deep-link to the session). Validated: 203 sessions summarized 100% ok; palette returns session+message hits."
  - "PHASE 5 — Enrichment tuning + memory intelligence. Migration 0018: `memories.superseded_by` + `memory_relations` table. Tuned enrichment selector (real-msg floor≥4 excl. sidechain/system_prompt, grace 1h, growth≥5, error-retry-24h, excludes only KNOWN-inactive projects); bridget-quality prompt + provenance (`evidence_msg_ids`/`quote`/`reasoning`, drop conf<0.3); project inheritance. `memory-judge.ts` (LLM duplicate/refines/contradicts). `resolveEnrichedMemory` (`memory-resolve.ts`): exact-hash merge | judge → auto-supersede(+archive+`memory_relations`+`superseded_by`) | review-supersede(+relation+review item) | contradict(+relation+review item) | insert — runs in enrichment ONLY (manual MCP/REST saves keep cheap `createMemory`). `/review` resolves memory-conflict items (accept/keep-both); `/memories` surfaces source-session link + quote + reasoning + relation badges. Validated live: 10 imported sessions → 20 inserted, 6 auto-superseded, 1 merged; 6 `supersedes/active` relations; 26 memories with provenance + project."
  - "Gates at ship: pnpm typecheck=0, pnpm test=315, pnpm build OK. 40+ commits on `feat/bridget-parity`. Subagent-driven (fresh implementer + spec/code-quality review per task, final integration review per phase)."
deferred:
  - "NOT MERGED to master — the whole cycle is on `feat/bridget-parity`. Merge via finishing-a-development-branch when ready."
  - "Import target was the LOCAL DEV db (DATABASE_URL=localhost). For PROD, re-run `scripts/migrate-bridget-sessions.ts` against prod DATABASE_URL. Hermes (505 sessions / 184K msgs) not imported — `--source=hermes` adds it."
  - "The old enrichment scheduler ran the pre-Phase-5 (crude) logic over many imported sessions during the build → ~1289 memories with NO provenance/project/relations exist in the dev db. The new logic only applies to never-enriched/grown/errored sessions (83 were still eligible + got the new pipeline). A full re-sweep with the new logic (reset `mem_enrichment_state` + archive old memories + re-run) is a deliberate Tony decision, not done."
  - "Message-embedding backfill is incremental (was ~4.5K/96.7K at handover) — the `embed-messages` scheduler fills the rest over hours; semantic message search sharpens as it completes (trigram works now)."
  - "Phase-5 minors (non-blocking): `sess_summary_state.model` unwritten; review-list left-joins documents on a memory `docId` (yields null path, harmless — `docId` is overloaded across doc + memory items); `onePendingPerDoc` silently de-dups a 2nd pending conflict for the same memory (matches existing enrichment-doc behavior)."
---

# Cycle 13 — Bridget Parity — handover

## What this is
Cycle 13 began as "an API-key management UI" and was broadened (Tony's call during brainstorm) into **replacing the bridget memory service** end-to-end, after an audit found MyMind's shipped session ingestion + enrichment were materially lower-fidelity than bridget's, and that bridget's session summarization + session/message search didn't exist in MyMind. Built as 5 sequential phases, each plan → subagent-driven build → review.

Source of truth for behaviour: the three wiki pages (`api-tokens.md`, `sessions.md`, `memory.md`) + the code. The spec (`2026-06-15-bridget-parity-design.md`) holds the frozen intent; this handover records what shipped.

## Decisions Tony locked
- Full parity in one cycle. No token scopes (session-gated mgmt endpoints instead). Capture fidelity is the gate before pointing real CC hooks at MyMind. Import RAW data only (sessions/messages/tool_events), regenerate memories locally. claude_code only (hermes deferred). Conflict policy = auto-resolve confident refinements, review-gate contradictions + low-confidence. Rich provenance + a relationship graph. Worked on `feat/bridget-parity` (not master).

## Gotchas worth carrying forward (also in the cycle memory)
- Run the import with `node_modules/.bin/tsx --env-file=.env scripts/…` (NOT `node --import tsx` — tsx is only a `.bin` symlink in this pnpm layout).
- bridget's data is in the `bridget` database; `BRIDGET_DATABASE_URL` may point at `/postgres` — the import script auto-retargets `/bridget`.
- HNSW (`halfvec_cosine_ops`) + GIN (`gin_trgm_ops`) indexes must be HAND-APPENDED as raw SQL to the drizzle-generated migration (drizzle can't emit them).
- `server/db/types/halfvec.ts` hardcoded the SQL column name `'embedding'`; it now takes a `columnName` arg (sessions passes `'summary_embedding'`).
- `nitro.scheduledTasks` object keys must be unique (TS1117) — multiple tasks share one cron via the array value.
- The enrichment active-project guard must exclude only KNOWN-inactive projects (`not in (… where active=false)`), else imported sessions (unregistered projects) never enrich.

## Where the next seam is
1. **Merge** `feat/bridget-parity` to master (finishing-a-development-branch) — the whole cycle is unmerged.
2. **Prod import** — re-run the import script against prod `DATABASE_URL`; consider Hermes (`--source=hermes`).
3. **Re-sweep decision** — whether to regenerate the ~1289 old-logic memories with the new provenance/relationship pipeline (reset state + archive + re-run).
4. The backlog's remaining Round-3 items (cycle 14 in-app chat UI is the obvious next feature; the agent core already exists).
