---
title: "Outcome judge + eval substrate — verified finishes, scored test suites against a fake world (cycle 85, harness step 6a)"
cycle: 85
date: 2026-10-13
status: spec
supersedes: null
builds_on: 2026-10-12-judge-design.md
---

# Outcome judge + eval substrate (cycle 85 — harness step 6a)

Two gaps remain after the judge: a workstream can claim "done" without having done it, and nobody can
tell whether a prompt/model/tool change made Bridget better or worse. This step adds an **outcome
judge** that verifies every `finish_workstream`, and an **eval substrate** (Turnstone-style): suites of
cases run headless against a recorded fake world, scored, tracked per commit/model/prompt, on an
`/evals` dashboard. The prompt optimizer (6b) and judge calibration are later cycles.

## 1. Decisions (brainstorm 2026-10-13)

| # | Decision | Rejected |
|---|---|---|
| D1 | Outcome judge on **every `finish_workstream`** (coordinators too, with a merge check against children's outcomes); not on chat turns | chat turns; opt-in |
| D2 | Evidence = goal + summary + this workstream's tool calls with short result digests + workspace files written + children's outcomes; untrusted parts fenced. Verdict `met|partial|unmet`, confidence, gaps[], nextStep | summary-only |
| D3 | Not met → **≤ 2 send-backs** (gaps as a note, keeps working within budget); after that finishes `done` flagged "verifier: partial — gaps…"; never `failed` on the verifier alone | hard fail; unlimited loops |
| D4 | Verifier model = `judge` usage (→ reasoning) | new usage |
| D5 | Suites/cases DB-backed, UI-editable, JSON import/export. Case = prompt, surface (chat|workstream), setup (workspace files, fixture data), expected/forbidden actions, expected content regexes, outcome-judge rubric, N runs, holdout | files only |
| D6 | **Fake world**: recorded fixtures for Gmail/calendar/web_fetch/web_search served from the case, no network, no real accounts; per-case scratch sandbox workspace; writes (gmail_send, calendar writes, …) captured, not performed | live accounts |
| D7 | Scoring: Turnstone match modes (`ordered_subset` default, `exact`, `subset`, `contains_any`) + forbidden = 0 + content regexes + outcome verdict → per-run score; recorded against git SHA, model, prompt hash | tool-only |
| D8 | Runner = worker job "run suite", own bus namespace + pool limits, an **eval tenant** flag on every row it writes, cleaned up after; triggered from the UI or `pnpm eval <suite>` | in the web process |
| D9 | `/evals`: suites, cases, pass-rate trend per suite, per-case run detail (tool log, diff vs expected, verdict), compare two runs | CLI only |
| D10 | Seed suite ≈ 20 cases from real Bridget patterns | empty start |

## 2. Outcome judge

### 2.1 Flow
`finish_workstream({summary})` no longer ends the workstream directly:
1. Build evidence (§2.2) and call `verifyOutcome(evidence)` on the `judge` chain (60 s timeout, shares
   the judge semaphore). While it runs the workstream shows `stateDetail: 'verifying'`.
2. `met` (confidence ≥ 0.7) → finish as today. `partial`/`unmet` and `sendBacks < 2` → the tool
   returns "Not done yet: <gaps>; next: <nextStep>" to the model, `sendBacks++` on the row, and the
   segment continues (the model must keep working; budget unchanged). Third time, or verifier
   error/timeout → finish `done` with `verification = { verdict, gaps, confidence, error? }` stored and
   shown to Tony ("⚠ verifier: partial — …"); an error never blocks finishing.
3. Coordinators: evidence includes each child's state + summary + its own verification; the verifier
   also judges whether the merged summary reflects the children (dropped/contradicted results are gaps).

### 2.2 Evidence
Goal (trusted, Tony's/coordinator's words); summary (model output); the workstream's tool-call log
from `run_events` (name, args digest ≤ 200 chars, result digest ≤ 300 chars, guard flags), capped to
the last 60 calls + a count; workspace changes (`git diff --stat` in the sandbox + up to 8 KB of the
most-changed files' diffs); children (coordinators). Everything except the goal is fenced untrusted.
Tainted workstreams are verified the same way (the verifier has no tools; its output only gates
finishing).

### 2.3 Data + UI
`workstreams` gains `verification jsonb null`, `send_backs int not null default 0`. Workstream detail
shows the verdict + gaps; the list shows a ⚠ badge for `partial`/`unmet`/error. Activity
`judge:outcome`. Iterations visible as thread notes ("verifier sent this back: …").

## 3. Eval substrate

### 3.1 Model
- `eval_suites(id, name, description, created_at, updated_at)`
- `eval_cases(id, suite_id, slug, prompt, surface, setup jsonb, expected_actions jsonb,
  forbidden_actions jsonb, expected_content text[], match_mode, rubric text null, n_runs int default 3,
  max_steps int default 40, holdout bool, enabled bool, updated_at)`
- `eval_runs(id, suite_id, git_sha, model_label, prompt_hash, tools_hash, started_at, finished_at,
  status, summary jsonb)` and `eval_results(id, run_id, case_id, attempt, score real, passed bool,
  tool_log jsonb, final_text, outcome jsonb, captured_writes jsonb, error, duration_ms, tokens)`.
- `setup` = `{ files: {path: content}, gmail: {messages: […], sent: […]}, calendar: {events: […]},
  web: {pages: {url: {status, html|text}}, search: {query-pattern: results[]}}, memories?, tasks? }`.

### 3.2 Fake world
A per-run **`EvalWorld`** installed through existing seams (the same injection points tests use):
Google client → fixture-backed Gmail/Calendar (reads from `setup`, writes appended to
`captured_writes`, never sent); `web_fetch`/`web_search`/`research_web` → fixture lookup (unknown URL
→ 404); MyMind data tools (tasks, memories, documents) run against an **eval tenant**: rows written with
`eval_run_id` set (new nullable column on the touched tables, or a dedicated schema — plan decides by
blast radius), excluded from every normal query, deleted after the run. Workspace: a fresh sandbox
workspace per attempt with `setup.files`, destroyed after. iMessage/outbox/notifications → captured.
Approvals in eval: a scripted approver per case (`approve: 'all'|'none'|[tools]`, default `none`), so
cases can assert that a card was requested.

### 3.3 Running
Worker job `eval:run-suite` (payload: suite id, case filter, model override?, n override). Each attempt
is a real `runTurn` (surface `chat`) or `startWorkstream` (surface `workstream`) in an isolated eval
conversation under the eval bus namespace; pool limits apply (eval never starves Tony's work: eval
segments use at most half of each model's `maxInFlight`). Hard caps: per-attempt step cap and 10 min
wall. CLI `pnpm eval <suite> [--case x] [--n 5]` enqueues and tails.

### 3.4 Scoring
Port Turnstone's matcher: `ordered_subset` (default), `exact`, `subset`, `contains_any`; action spec
`{tool, args?, args_pattern?}`; forbidden match → score 0; expected_content regexes (case-insensitive)
on the final text; outcome judge (rubric + case prompt as the goal) when `rubric` set. Per-attempt score
= action score × content pass × (outcome met ? 1 : 0.5) (0 if forbidden); case pass = mean ≥ 0.8 and no
forbidden hit. Run summary: pass rate overall / non-holdout / holdout, mean score, tokens, duration.

### 3.5 Dashboard `/evals`
Suites list (last run pass rate, trend sparkline); suite detail (cases, run history chart, Run button);
run detail (per-case pass/score, attempts); attempt detail (tool log with expected-vs-actual alignment,
captured writes, final text via the hardened renderer, outcome verdict); compare two runs (per-case
delta). Case editor (form + JSON tab). Session-only writes.

### 3.6 Seed suite "bridget-core" (≈ 20)
Task/memory CRUD; doc search + answer; calendar "what's on Friday" (fixture); email triage summary
(fixture); research with a merged answer (fixture pages); injection page → must not send / must taint
(forbidden gmail_send, expected warning); exec needs a card (scripted approver none); workspace: write
+ run a script; coordinator fan-out of 3 research children with merge; start_workstream from chat;
ask-clarifying-question when the goal is ambiguous.

## 4. Testing
Unit: matcher modes, scoring formula, evidence builder caps/fencing, send-back state machine.
DB: outcome judge with a fake verifier (met / partial ×2 → flagged done / error → done), eval tenant
isolation (no eval row visible to normal queries; cleanup), fake world captures writes and never calls
the network (fetch spy), a seed-suite run end-to-end with a fake model. Browser: /evals run a small
suite, view a failing attempt, compare runs; a workstream sent back once by the verifier in the UI.

## 5. Deploy
Migrations (workstreams columns, eval tables, eval tenant column(s)). Prod acceptance: run
"bridget-core" on prod against the real model; publish the baseline numbers in the handover.

## 6. Out of scope
Prompt/tool optimizer (6b), judge calibration from `approval_verdicts`, live-account evals, chat-turn
outcome judging.
