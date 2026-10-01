# Memory Dual Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every live memory carries two current scores, an `extract-v3` LLM audit and Jev, filled by a resumable backfill and shown on `/memories`. Extraction itself improves (`extract-v3`), and doc-worthy detail is routed to triage.

**Architecture:**
- `server/lib/memory/extract-v3.ts` is the single definition of "a good memory". It holds the extraction prompt, the audit prompt and their tolerant parsers.
- `server/services/memory-scoring.ts` scores one memory with both Jev and the audit. It is called after creation, by the existing queue scorer, and by a new backfill task that a settings switch gates.
- The `/memories` API gains score fields, filters and sorts. The page reuses the `/review` score display.

**Tech Stack:** Nuxt 4 / Nitro scheduled tasks, Drizzle + Postgres, `chat('bulk')`, `askJev`, Nuxt UI, vitest, `playwright-cli`.

**Spec:** `docs/superpowers/specs/2026-10-01-memory-dual-scoring-design.md`

## Global Constraints

- **Toolchain:** pnpm only. Gates are `pnpm test`, `pnpm test:db` (the DB files touched), `pnpm typecheck`, and `pnpm build` when app/ or the nuxt config is touched. No attribution trailers in commits.
- **Migration:** 0064, additive. Never edit an applied migration.
- **Shared dev DB with real data:**
  - Scope every DB test to rows it creates.
  - Call passes through their seams (`onlyIds`).
  - Never splice raw `sql` containing `or`/`true` into `and()`.
  - Commit real work BEFORE any mutation check, then restore with `git checkout -- <file>`.
  - Snapshot and restore any setting you touch.
  - Report real row counts.
- **No real model or Jev calls in automated tests.** The eval script and the dev acceptance run are the only real calls.
- **No automatic action on memories** (D5): no archiving, no change to auto-review, no edits to memory content.
- **Prompt version strings:** `EXTRACT_PROMPT_VERSION = 'extract-v3'`, `AUDIT_PROMPT_VERSION = 'audit-v1'` (the audit applies the extract-v3 criteria).
- **Numbers:**
  - backfill: 40 memories per run, every 5 min; Jev concurrency 6, audit concurrency 2;
  - skip a row after 3 failures;
  - disagreement threshold 0.4;
  - audit `reason` ≤ 200 chars;
  - confidence anchors 0.9 / 0.7 / 0.5 / < 0.4.
- **Audit verdicts:** exactly `keep | transient | redundant | wrong_scope | belongs_in_doc`.
- **Mirror guard:** documents under `/projects/*/wiki/` or `/projects/*/handovers/` count as repo mirrors. A doc candidate never proposes an append to them; it is filed as a note proposal. (The `documents` table has no mirror marker; this is the mirror convention's path rule.)
- **Nuxt UI rules apply.** No empty-string select item values.

## Review Focus

1. **The audit returns prose or truncated JSON.** The row's `audit_failures` goes up, the row is retried on a later run, and after 3 failures it is skipped. Nothing throws out of the task. Test: Task 3.
2. **The backfill re-selects a row the queue scorer is scoring at the same moment.** Both write the same values. Stamping is idempotent: the last write wins with identical meaning, and there is no duplicate side effect. Test: Task 5.
3. **A memory is archived mid-backfill.** It is skipped from that point on, because selection uses the shared `live()` predicate. Test: Task 5.
4. **The v3 extractor emits a `doc_candidate` with no project and no hint.** A capture is still created, and its text says "(no project)". Nothing crashes. Test: Task 6.
5. **The disagreement filter on a memory with only one score.** It is excluded from "disagree", never treated as 0. Test: Task 7.

---

### Task 1: Schema 0064, DTO, backfill setting

**Files:**
- Modify: `server/db/schema/memories.ts`, `shared/types/memory.ts` (`MemoryDTO`), `server/services/memory.ts` (`toDTO`)
- Create: `server/lib/memory/backfill-setting.ts`, `test/memory-dual-schema.db.test.ts`

**Interfaces (produces):**
```ts
// memories columns
auditKeep: real('audit_keep'), auditVerdict: text('audit_verdict'), auditReason: text('audit_reason'),
auditModel: text('audit_model'), auditPromptVersion: text('audit_prompt_version'),
auditedAt: timestamp('audited_at', { withTimezone: true }), auditFailures: integer('audit_failures').notNull().default(0),
extractPromptVersion: text('extract_prompt_version'), jevFailures: integer('jev_failures').notNull().default(0)
// MemoryDTO gains: jevScore: number | null; jevAnswers: Record<string, number> | null; auditKeep: number | null;
//   auditVerdict: AuditVerdict | null; auditReason: string | null; auditPromptVersion: string | null; extractPromptVersion: string | null
export type AuditVerdict = 'keep' | 'transient' | 'redundant' | 'wrong_scope' | 'belongs_in_doc'   // shared/types/memory.ts
// backfill-setting.ts (settings key 'memory_backfill', tolerant parse, default { state: 'off' })
export interface BackfillSetting { state: 'off' | 'running' | 'done'; startedAt: string | null; finishedAt: string | null }
export async function getBackfillSetting(): Promise<BackfillSetting>
export async function setBackfillState(state: BackfillSetting['state']): Promise<BackfillSetting>  // stamps startedAt on →running, finishedAt on →done
```
- [ ] **Step 1.** Edit the schema. Run `pnpm db:generate` and expect a single `0064_*.sql` containing 9 ADD COLUMNs. Inspect it, then run `pnpm db:migrate`.
- [ ] **Step 2.** Extend the DTO and `toDTO`. `jevAnswers` is the stored flat object (the `{ transient: 0.76, … }` shape).
- [ ] **Step 3.** DB test:
  - a scoped memory round-trips the new fields through `toDTO`;
  - the setting is tolerant and its transitions stamp the times.
  - Snapshot and restore the `memory_backfill` key.
- [ ] **Step 4.** Run the gates. Commit `feat(memory): schema 0064 — audit and dual-score fields, backfill setting`.

---

### Task 2: `extract-v3` extraction prompt, parser, doc candidates, eval

**Files:**
- Create: `server/lib/memory/extract-v3.ts`, `test/memory-extract-v3.test.ts`, `scripts/memory-eval.ts`, `scripts/data/memory-eval-v3.jsonl`
- Modify:
  - `server/services/memory-enrich.ts`: `SYSTEM_PROMPT` → the v3 prompt; `extractMemoriesFromTranscript` returns `{ memories, docCandidates }`. Update its two callers, and stamp `extractPromptVersion` on created memories.
  - `server/lib/ai/memory-extract.ts`: keep `parseMemories`; add a v3 wrapper.
  - `package.json` script `memory:eval`.
  - `.gitignore` carve-out `!scripts/data/memory-eval-v3.jsonl`.

**Interfaces (produces):**
```ts
export const EXTRACT_PROMPT_VERSION = 'extract-v3'
export const EXTRACT_SYSTEM_PROMPT: string
export interface DocCandidate { text: string; project: string | null; targetDocHint: string | null }
export function parseExtractV3(raw: string): { memories: MemoryCandidate[]; docCandidates: DocCandidate[] }
  // uses parseMemories for `memories` (same 0.6 floor); doc_candidates tolerant: drop items without text, trim, cap 5
```
- **Prompt content** (verbatim intent; keep the existing scope definitions and output shape and add `doc_candidates`):
  - **Durable facts only.** Extract only facts that will still be true and useful in six months.
  - **REJECT, as time-sensitive or likely stale:** pending or planned work ("has a pending …", "next we will …"); the state of in-progress work; versions, counts, prices or dates expected to change; anything phrased "currently / now / today"; TODOs and steps someone must take.
  - **Route, don't extract.** Architecture detail, spec or handover content and multi-step how-tos are NOT memories. Put them in `doc_candidates` as `{ text, project, targetDocHint }`.
  - **Each memory must be:** a single fact; self-contained (it names the project or thing); free of "this/that/it" references to the transcript.
  - **Confidence anchors:** 0.9 = a stable fact about Tony or the system; 0.7 = durable but could change this year; 0.5 = likely to change within weeks; below 0.4 = do not extract.
  - **Most transcripts yield 0–3 memories.** An empty list is a correct answer.
- **Eval:** `scripts/memory-eval.ts` makes real `chat('bulk')` calls and never writes to the DB.
  1. Run the v3 prompt over 20 hand-written transcript rows (`{ transcript, expectKeep: string[], expectReject: string[], expectDoc: boolean }`). Report the keep rate and the stale-rejection rate.
  2. Run the **audit** (Task 3) over the 45 labelled rows in `scripts/data/memory-labels-2026-09-22.jsonl`. Load their content from `scripts/data/memory-sample-2026-09-22.jsonl` by id. Report agreement of verdict vs label (`keep` ↔ keep, `stale` ↔ transient, `noise` ↔ redundant/wrong_scope).
  3. Exit 0 in all cases.

  The run before merge must meet: ≥ 90% of expected durable memories kept, ≥ 80% of planted stale facts rejected. The controller runs this in Task 8.
- [ ] **Step 1. Failing tests for `parseExtractV3`:**
  - `{ memories, doc_candidates }` parses;
  - a missing `doc_candidates` gives `[]`;
  - candidates without text are dropped;
  - at most 5 candidates are kept;
  - garbage gives `{ memories: [], docCandidates: [] }`.
- [ ] **Step 2.** Implement the module, the prompt and the enrich wiring. Existing enrich tests stay green; update any that assert the old return shape.
- [ ] **Step 3.** Write the 20 eval rows: 8 durable, 8 stale/pending, 4 doc-worthy, with mixes. Write the eval script (no DB).
- [ ] **Step 4.** Run the gates. Commit `feat(memory): extract-v3 prompt — stale/pending rejected, doc candidates, eval harness`.

---

### Task 3: The LLM audit

**Files:**
- Modify: `server/lib/memory/extract-v3.ts` (add the audit)
- Create: `test/memory-audit.test.ts`

**Interfaces (produces):**
```ts
export const AUDIT_PROMPT_VERSION = 'audit-v1'
export const AUDIT_VERDICTS = ['keep', 'transient', 'redundant', 'wrong_scope', 'belongs_in_doc'] as const
export function auditMessages(m: { content: string; project: string | null; ageDays: number; scope: string }): ChatMessage[]
export function parseAudit(raw: string): { ok: true; keep: number; verdict: AuditVerdict; reason: string } | { ok: false; error: string }
  // tolerant JSON extraction (fence/prose); keep clamped to [0,1]; unknown verdict → ok:false; reason trimmed to 200 chars
export async function auditMemory(m: …, deps?: { chatFn?: typeof chat }): Promise<ReturnType<typeof parseAudit> & { model?: string }>
  // chat('bulk', auditMessages(m), { temperature: 0, maxTokens: 300 }); thrown error → ok:false
```
- The audit system prompt restates the extract-v3 criteria. It asks: "Would this memory pass these criteria if extracted today, and how durable is it?" The reply must be JSON only: `{ "keep": 0-1, "verdict": one of …, "reason": "…" }`.
- [ ] **Step 1. Failing tests** for `parseAudit`:
  - a clean reply parses;
  - a fenced reply parses;
  - prose before the JSON parses;
  - keep 1.4 is clamped to 1;
  - an unknown verdict gives ok:false;
  - empty input gives ok:false;
  - a 500-char reason is trimmed to 200.

  Also: `auditMessages` includes the age and the project, and `auditMemory` returns ok:false when a stubbed `chatFn` throws.
- [ ] **Step 2.** Implement, run the gates, commit `feat(memory): extract-v3 audit of an existing memory`.

---

### Task 4: One scoring function; Jev on every live memory; new memories scored

**Files:**
- Create: `server/services/memory-scoring.ts`, `test/memory-scoring.db.test.ts`
- Modify:
  - `server/services/memory-jev.ts`: selection now covers live memories regardless of review, unreviewed first, then oldest; jev failures are counted; it delegates to the shared function.
  - `server/services/memory-enrich.ts`: after creating memories, call `scoreMemories(ids)` fire-and-forget.

**Interfaces (produces):**
```ts
export interface ScoreResult { id: string; jev: 'scored' | 'failed' | 'skipped'; audit: 'scored' | 'failed' | 'skipped' }
export async function scoreMemory(id: string, deps?: { ask?: typeof askJev; cfg?: JevConfig | null; chatFn?: typeof chat; now?: Date }): Promise<ScoreResult>
  // loads the live row (isNull archivedAt); Jev part only when jev_scored_at is null and jev_failures < 3; audit part only when
  // audit_prompt_version is distinct from AUDIT_PROMPT_VERSION and audit_failures < 3; stamps success fields, or increments the failure counter
export async function scoreMemories(ids: string[], deps?: …): Promise<ScoreResult[]>   // jev concurrency 6, audit concurrency 2
export async function selectUnscored(limit: number, opts?: { onlyIds?: string[] }): Promise<string[]>   // live rows missing either score, failures < 3; unreviewed first, then oldest
```
- [ ] **Step 1. Failing DB tests** (scoped memories; stubbed `ask`/`chatFn`):
  - both scores are stamped (jev answers/model, audit fields + version);
  - an already-scored part is skipped;
  - a failure increments its counter and the 3rd failure skips that part;
  - an archived row is never scored;
  - `selectUnscored` orders unreviewed-first, then oldest, respecting `onlyIds`;
  - **Review Focus 2:** two concurrent `scoreMemory` calls give a consistent final state.
- [ ] **Step 2.** Implement and refactor `runJevScoring` onto `scoreMemories` + `selectUnscored`. The existing jev tests stay green; update any that assert unreviewed-only selection, since spec D2 changes that.
- [ ] **Step 3.** Run the gates. Commit `feat(memory): one scoring path — Jev and audit on every live memory, new memories scored`.

---

### Task 5: Backfill task and control API

**Files:**
- Create:
  - `server/tasks/memory-backfill.ts`
  - `server/services/memory-backfill.ts`
  - `server/api/memories/backfill.get.ts` (progress)
  - `server/api/memories/backfill.put.ts` (`{ state: 'running' | 'off' }`)
  - `test/memory-backfill.db.test.ts`
  - `test/memory-backfill-routes.test.ts`
- Modify: `nuxt.config.ts` scheduledTasks `'*/5 * * * *'` += `memory-backfill`; `shared/types/live.ts` + live dispatch (`memoryBackfill` → `['memory-backfill']`)

**Interfaces (produces):**
```ts
export interface BackfillProgress { state: BackfillSetting['state']; total: number; jevDone: number; auditDone: number; skipped: number; remaining: number; startedAt: string | null; etaMinutes: number | null; lastError: string | null }
export async function backfillProgress(): Promise<BackfillProgress>   // counts over live memories
export async function runBackfillBatch(opts?: { limit?: number; onlyIds?: string[]; deps?: … }): Promise<{ processed: number; done: boolean }>
  // state must be 'running' (else no-op); selectUnscored(limit 40) → scoreMemories; when selectUnscored returns none → setBackfillState('done')
```
- The routes use `requireSession`. The task wraps the work in `withSpan` + `recordJobSummary`.
- [ ] **Step 1. Failing tests:**
  - `state: off` does nothing;
  - `running` processes up to the limit;
  - the empty set flips the state to `done`;
  - progress counts are correct (scoped via `onlyIds`);
  - **Review Focus 3:** a row archived between two batches is not scored;
  - the routes refuse non-session callers and validate the state;
  - publish `memoryBackfill` on state change and after each batch.
- [ ] **Step 2.** Implement, run the gates, commit `feat(memory): resumable dual-score backfill behind a switch`.

---

### Task 6: Doc candidates → triage

**Files:**
- Create: `server/services/memory-doc-candidates.ts`, `test/memory-doc-candidates.db.test.ts`
- Modify: `server/services/memory-enrich.ts` (file each candidate after extraction, fire-and-forget)

**Interfaces (produces):**
```ts
export function isRepoMirrorPath(path: string): boolean   // /^\/projects\/[^/]+\/(wiki|handovers)\//
export async function fileDocCandidate(c: DocCandidate, src: { sessionId?: string; conversationId?: string }): Promise<{ docId: string } | null>
  // creates a /input/ capture doc (the same createDoc path quick_capture uses) whose body is:
  //   "<text>\n\n— From memory extraction (project: <project or '(no project)'>; suggested doc: <hint or 'none'>)"
  // then triageCapture(docId) fire-and-forget; errors logged, never thrown
```
- **Mirror guard.** In `server/services/triage.ts` `resolveAppendTarget` (or its caller), a resolved target whose path is a repo mirror (`isRepoMirrorPath`) is rejected for append, and the action is proposed as a note instead. This applies to ALL captures, not only doc candidates, because an append to a mirrored doc is always lost on the next sync.
- [ ] **Step 1. Failing tests:**
  - `isRepoMirrorPath` cases;
  - `fileDocCandidate` creates a capture with the expected body (scoped path prefix; delete after);
  - **Review Focus 4:** with no project and no hint, the body says "(no project)";
  - a triage append resolving to a `/projects/x/wiki/…` doc becomes a note proposal (stub `classify`).
- [ ] **Step 2.** Implement, run the gates, commit `feat(memory): doc-worthy extractions become triage captures; no appends to repo-mirrored docs`.

---

### Task 7: `/memories` dual scores, filters, sorts; backfill card

**Files:**
- Create:
  - `app/components/memory/ScoreBadges.vue`: extracts the `/review` confidence + Jev display (`jevColor`/`jevTooltip`) and adds the audit badge.
  - `app/lib/memory/scores.ts` (pure: colours, tooltip text, `disagreement(a, b): number | null`).
  - `app/components/settings/MemoryBackfillCard.vue`.
  - tests `app/lib/memory/scores.test.ts`, `test/memories-api-filters.db.test.ts`.
- Modify:
  - `server/api/memories/index.get.ts` + `listMemories`: query params `verdict`, `scored=yes|no`, `disagree=1`, `sort=created|audit|jev|disagreement`. Filtering and sorting run in SQL; disagreement is `abs(audit_keep - jev_score)` and is null when either is null.
  - `app/pages/memories.vue`: badges, filter controls and a sort select.
  - `app/pages/review.vue`: uses `ScoreBadges`.
  - The Settings page hosting the backfill card: add it to the existing memory-related settings page if one exists, otherwise a new `/settings/memory` with a nav entry.

**Interfaces:**
- `disagreement(a, b)` is `Math.abs(a - b)`, or `null` if either side is null. The "disagree" filter is `>= 0.4` with both scores non-null (**Review Focus 5**).
- The score colours reuse the `/review` bands: < 0.4 warning, < 0.6 neutral/muted, else success.
- The backfill card has:
  - Start / Pause (PUT state);
  - a live `UProgress` of `(jevDone + auditDone) / (2 * total)`;
  - counts, ETA and last error;
  - the text "Scores existing memories with Jev and the extract-v3 audit. No memory is changed."
- [ ] **Step 1. Failing tests:**
  - the pure score helpers;
  - the API filters and sorts on scoped memories, including the single-score exclusion for `disagree`.
- [ ] **Step 2.** Implement.
- [ ] **Step 3. Browser-validate** with `playwright-cli` (spare port, `BETTER_AUTH_URL` matching):
  - `/memories` shows both badges with tooltips; filter by verdict and by disagree; sort by each score;
  - `/review` still shows its scores;
  - the backfill card starts and pauses (snapshot and restore the setting), and progress renders.
  - Screenshots go in the scratchpad.
- [ ] **Step 4.** Run the gates, including build. Commit `feat(memory): both scores on /memories with filters and sorts; backfill control`.

---

### Task 8: Export, acceptance, docs

**Files:**
- Create: `scripts/memory-export.ts`, `docs/handovers/2026-10-01-memory-dual-scoring.md`
- Modify: `package.json` (`memory:export`), `docs/wiki/memory.md`, `docs/wiki/triage.md`, roadmap row 77

- **Export:** reads only. It writes `scripts/data/memory-scores-<date>.csv` and `.jsonl` (gitignored) with the spec §7 fields, joined to labels from `scripts/data/memory-labels-*.jsonl` by id.
- [ ] **Step 1.** Run all the gates.
- [ ] **Step 2. Acceptance on dev:**
  - `pnpm memory:eval` once, recording keep and stale-rejection rates plus audit-vs-label agreement against the bar;
  - start the backfill with `runBackfillBatch({ limit: 40 })` once, using real Jev + audit on 40 dev memories;
  - check `/memories` shows them;
  - `pnpm memory:export` produces the files;
  - set the switch back to `off`, which is its pre-test state.
  - Report counts.
- [ ] **Step 3. Docs:**
  - the memory wiki covers extract-v3, the audit, the two scores, the backfill, the export and doc candidates;
  - the triage wiki covers the mirror guard;
  - the handover lists every ledger ruling, plus deploy steps: migrate, leave the backfill switch off, Tony starts it on prod, and analysis follows;
  - update the roadmap row.
- [ ] **Step 4.** Commit `docs(cycle-77): memory dual scoring wiki, handover, roadmap`.

## Self-review notes (planning rulings)

- **The `documents` table has no repo-mirror marker,** so the guard uses the mirror convention's paths (`/projects/*/wiki/`, `/projects/*/handovers/`). Because append-to-mirror is always lost on the next sync, the guard covers all triage appends, not only doc candidates.
- **Queue scoring now covers all live memories, unreviewed first** (spec D2). The 50-per-run queue task and the backfill share `selectUnscored`/`scoreMemories`.
- **The audit runs on the `bulk` chain,** the same as extraction. The `reasoning` alias emits think blocks, which `chat()` rejects.
