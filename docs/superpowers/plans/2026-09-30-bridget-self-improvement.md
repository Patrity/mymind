# Bridget Self-Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridget learns from experience. A tool-less reflector turns settled threads into skill and "About Tony" profile proposals, and a nightly pass tunes jobs from engagement signals. A code gate (including a one-way Jev check) routes each proposal to auto-apply or `/review`. Bridget can also list and decide reviews herself, with Tony confirming each decision.

**Architecture:** New `server/lib/agent/reflect/` (candidates → transcript → model call → zod proposals) feeds a pure gate (`reflect/gate.ts`). The gate's routes are applied through the existing skill/job stores, a new profile store, or a new `self-improvement` review kind; every proposal is recorded in `agent_improvements`. Engagement signals are written by the existing runtime/channel hooks into `agent_signals`. A shared `reviewChoices` registry drives the `/review` page, a `list_reviews` tool and an approval-gated `decide_review` tool, all of them calling one extracted `review-decisions` service.

**Tech Stack:** Nuxt 4 / Nitro scheduled tasks, Drizzle + Postgres, `chat()` / `withFailover` over the `reasoning` chain, `askJev`, zod, Nuxt UI, vitest (`pnpm test`, `pnpm test:db`), `playwright-cli`.

**Spec:** `docs/superpowers/specs/2026-09-30-bridget-self-improvement-design.md`

## Global Constraints

- pnpm only. Gates: `pnpm test`, `pnpm test:db` (the DB files touched), `pnpm typecheck`, `pnpm build` (when app/ or nuxt config is touched). Lint is not a gate.
- Commit messages carry **no** attribution trailer.
- Migration **0063**, additive. Never edit an applied migration.
- The dev DB is shared with real data. Scope every DB test to rows it creates, call ticks/passes through their test seams, never splice raw `sql` with `or`/`true` into `and()`, mutate code rather than WHERE clauses, and re-verify real row counts afterwards.
- Mutation-check one file at a time and restore with `git checkout -- <file>` after each.
- Numbers, copied verbatim from the spec:
  - per-thread pass: ≥ 4 new messages, idle ≥ 30 min, not reflected in the last 2 h, task every 15 min, main included;
  - nightly jobs pass at 03:30 in the agent timezone; skip a job with < 5 signals in the last 14 days;
  - ≤ 3 proposals per pass; ≤ 5 auto-applies per day (agent timezone); ≤ 1 change per target per 24 h;
  - skill ≤ 4 KB; profile ≤ 1,500 tokens (estimate = ceil(chars / 4));
  - rejection memory 30 days at similarity ≥ 0.8; Jev bump threshold ≥ 0.6;
  - observation window 2 h; `list_reviews` default limit 20.
- The reflector has **no tools**. `decide_review` is `dangerous: true`, is never in `agentTools` (so MCP never sees it), and is refused in headless runs.
- Reflection never edits the persona.
- All model calls in tests are stubbed. No real model or Jev calls in automated tests. The eval script is run once by hand.
- Nuxt UI rules apply to `.vue` files. No empty-string select item values.
- Seed jobs install **disabled**.

## Review Focus

1. **A proposal whose "evidence" is paraphrased, not quoted.** It must be dropped, never applied. The check is whitespace-normalised verbatim substring only; there is no fuzzy match. Test in Task 6.
2. **A reflector reply that isn't clean JSON** (code fences, prose before the JSON, trailing commas, or an empty reply). Strip the fences, take the first JSON object, run zod, and on failure record "no proposals" plus a retry mark. It must never throw out of the task. Test in Task 5.
3. **Tony edits a skill between the pass and the apply.** CAS fails, the proposal goes to `/review` as `conflict` with the fresh content, and nothing is overwritten. Test in Task 7.
4. **A decision on an item that is no longer pending** (already decided on the page) or has an unknown kind. `decide_review` returns a plain explanation and changes nothing. Test in Task 9.
5. **Profile over budget at prompt time** (Tony pasted a long profile). The prompt injects the first 1,500 tokens (chars / 4) with a truncation marker and never throws, and the page shows the warning. Test in Task 2.

---

## File Structure

```
server/db/schema/agent-improve.ts              agentProfile, agentSignals, agentImprovements (+ conversations.reflectedThrough, agentConfigRevisions.improvementId)
server/lib/agent/config/revisions.ts           RevisionTargetKind += 'profile'; recordRevision accepts improvementId
server/services/profile.ts                     get/save (CAS)/revisions/revert for the single profile row
server/lib/agent/profile-budget.ts             estimateTokens, clampProfile (pure)
server/api/profile/{source.get,source.put,revisions.get,revert.post}.ts
server/lib/agent/self-improvement-mode.ts      get/set `self_improvement_mode`
server/api/settings/self-improvement.{get,put}.ts
server/lib/agent/signals/{classify.ts,write.ts}
server/lib/agent/reflect/{candidates.ts,transcript.ts,prompt.ts,schema.ts,call.ts,thread-pass.ts,jobs-pass.ts,gate.ts,jev.ts,apply.ts,similarity.ts}
server/tasks/reflect-threads.ts, server/tasks/reflect-jobs.ts
shared/review/choices.ts                       reviewChoices(item) — page + tool
server/services/review-decisions.ts            decideReview(item, choice) — routes + tool
server/lib/agent/tools/reviews.ts              list_reviews (agentTools), decide_review (profile-only, dangerous)
server/lib/agent/tools/improvements.ts         list_improvements
app/pages/settings/profile.vue, app/pages/settings/voice.vue (moved), app/components/review/SelfImprovementCard.vue
scripts/reflect-eval.ts, scripts/data/reflect-eval.jsonl
```

---

### Task 1: Schema 0063, revisions widening, mode setting

**Files:**
- Create: `server/db/schema/agent-improve.ts`, `server/lib/agent/self-improvement-mode.ts`, `test/self-improve-schema.db.test.ts`
- Modify:
  - `server/db/schema/index.ts` (export);
  - `server/db/schema/conversations.ts` (`reflectedThrough`);
  - `server/db/schema/agent-config.ts` (`agentConfigRevisions.improvementId uuid null`);
  - `server/lib/agent/config/revisions.ts` (`RevisionTargetKind = 'skill' | 'job' | 'profile'`; `recordRevision` takes an optional `improvementId`; `listRevisions` returns `improvementId`).

**Interfaces:**
- Produces:
  ```ts
  // agent-improve.ts
  export const agentProfile = pgTable('agent_profile', { id: uuid pk defaultRandom, content: text notNull default(''), contentHash: text notNull, updatedBy: text notNull default('human'), updatedAt: timestamptz notNull defaultNow })
  export const agentSignals = pgTable('agent_signals', { id, jobId: uuid → agentJobs set null, runId: uuid → agentRuns set null, messageId: uuid (nullable), deliveryId: uuid (nullable), kind: text notNull, detail: text, createdAt }, idx (jobId, createdAt), unique (messageId, kind) where messageId is not null)
  export const agentImprovements = pgTable('agent_improvements', { id, pass: text notNull, sourceConversationId: uuid null, sourceRunIds: uuid[] notNull default '{}', kind: text notNull, target: text notNull, proposal: jsonb notNull, jev: jsonb, route: text notNull, dropReason: text, status: text notNull, revisionId: uuid, reviewItemId: uuid, createdAt, decidedAt }, idx (status, createdAt), idx (kind, target, createdAt))
  export type SelfImprovementMode = 'on' | 'review_only' | 'off'
  export async function getSelfImprovementMode(): Promise<SelfImprovementMode>   // settings key 'self_improvement_mode', default 'on', tolerant parse
  export async function setSelfImprovementMode(m: SelfImprovementMode): Promise<void>
  ```

- [ ] **Step 1:** Write the schema, add `reflectedThrough: timestamp('reflected_through', { withTimezone: true })` to `conversations` and `improvementId: uuid('improvement_id')` to `agentConfigRevisions`, then run `pnpm db:generate`. Expect exactly one file, `0063_*.sql`, containing 3 CREATE TABLEs and 2 ADD COLUMNs. Inspect it, then run `pnpm db:migrate`.
- [ ] **Step 2:** Widen the revisions types. `recordRevision({ ..., improvementId? })` writes the column, and `listRevisions` selects it. Update every existing caller's types without changing behaviour.
- [ ] **Step 3: DB test.**
  - A profile row round-trips.
  - Inserting the same `(messageId, kind)` twice into `agent_signals` hits the unique index, so the test uses `onConflictDoNothing`.
  - `recordRevision` with `improvementId` round-trips, and `listRevisions('profile', id)` works.
  - `getSelfImprovementMode()` defaults to `'on'` and falls back to `'on'` on a malformed stored value. Snapshot and restore the settings key.
- [ ] **Step 4:** Run the gates. Commit `feat(self-improve): schema 0063 — profile, signals, improvements, reflection watermark`.

---

### Task 2: Profile store, API, prompt injection with budget

**Files:**
- Create:
  - `server/services/profile.ts`
  - `server/lib/agent/profile-budget.ts`
  - `server/api/profile/source.get.ts`
  - `server/api/profile/source.put.ts`
  - `server/api/profile/revisions.get.ts`
  - `server/api/profile/revert.post.ts`
  - `test/profile-budget.test.ts`
  - `test/profile.db.test.ts`
- Modify:
  - `server/lib/agent/prompt.ts`: `buildSystemPrompt` loads the profile; `composePrompt` gains `profile?: string` and emits `## About Tony\n<profile>` right after the persona.
  - `test/agent-prompt*.test.ts`

**Interfaces:**
- Consumes: `recordRevision`, `listRevisions`, `getRevision` (Task 1); `ConflictError` from `server/services/skills.ts`.
- Produces:
  ```ts
  export interface ProfileSource { content: string; contentHash: string; updatedBy: string; updatedAt: string }
  export async function getProfileSource(): Promise<ProfileSource>      // creates the single row lazily with '' content
  export async function saveProfileSource(content: string, expectedHash: string, actor: 'human' | 'agent' | 'system', opts?: { improvementId?: string }): Promise<ProfileSource>   // CAS → ConflictError
  export async function listProfileRevisions(): Promise<{ id: string; content: string; actor: string; createdAt: Date; improvementId: string | null }[]>
  export async function revertProfile(revisionId: string, actor: 'human' | 'agent' | 'system'): Promise<ProfileSource>
  export const PROFILE_TOKEN_BUDGET = 1500
  export function estimateTokens(s: string): number        // Math.ceil(s.length / 4)
  export function clampProfile(s: string): { text: string; truncated: boolean }   // at most 1500*4 chars; cut at the last newline before the limit; append '\n…(profile truncated)'
  ```
- API: follow `server/api/skills/[name]/source.get.ts`, `source.put.ts`, `revisions.get.ts` and `revert.post.ts` exactly. That means `requireSession`, a PUT body of `{ content, expectedHash }` returning 409 `{ current }` on conflict, and a 400 for a malformed revision id. `source.get` also returns `{ tokens, budget, overBudget }`.

- [ ] **Step 1: Failing pure tests** (`test/profile-budget.test.ts`):
  ```ts
  import { describe, it, expect } from 'vitest'
  import { estimateTokens, clampProfile, PROFILE_TOKEN_BUDGET } from '../server/lib/agent/profile-budget'
  describe('profile budget', () => {
    it('estimates tokens as ceil(chars/4)', () => { expect(estimateTokens('')).toBe(0); expect(estimateTokens('abcde')).toBe(2) })
    it('leaves a short profile untouched', () => expect(clampProfile('hi')).toEqual({ text: 'hi', truncated: false }))
    it('cuts an over-budget profile at a line boundary and marks it', () => {
      const long = Array.from({ length: 2000 }, (_, i) => `line ${i} xxxxxxxxxx`).join('\n')
      const r = clampProfile(long)
      expect(r.truncated).toBe(true)
      expect(r.text.length).toBeLessThanOrEqual(PROFILE_TOKEN_BUDGET * 4 + 40)
      expect(r.text.endsWith('…(profile truncated)')).toBe(true)
      expect(r.text.split('\n').slice(-2, -1)[0]).toMatch(/^line \d+ x+$/)
    })
  })
  ```
- [ ] **Step 2: Implement and pass.** `composePrompt` test: given `profile: 'Likes terse answers.'`, the output contains `## About Tony\nLikes terse answers.` after the persona. `buildSystemPrompt` catches a load failure: no profile section is emitted, and it never throws.
- [ ] **Step 3: DB tests.**
  - Save with the right hash → new hash plus a `profile` revision with the actor.
  - Stale hash → `ConflictError` with `current`.
  - Revert restores the content and records a new revision.
  - The lazy-created row has empty content.
  - Snapshot the real row first and restore it byte-for-byte after. Delete the revisions the test created by id.
- [ ] **Step 4: Route tests** (handler with mocked service): 401/403 without a session, 409 shape, 400 on a bad revision id.
- [ ] **Step 5:** Run the gates. Commit `feat(self-improve): About Tony profile store, API and prompt injection`.

---

### Task 3: Settings → Profile page, Settings → Voice move, self-improvement mode control

**Files:**
- Modify:
  - `app/lib/config/source.ts`: `ConfigKind` gains `'profile'`, and `configEndpoints('profile', _)` maps to `/api/profile/source|revisions|revert` with `queryBase: 'profile'`.
  - `app/composables/useConfigSource.ts`: add only what `'profile'` needs.
  - `app/components/config/RevisionsPanel.vue`: `kind="profile"`.
  - `app/layouts/default.vue`: add Settings entries `{ label: 'Profile', icon: 'i-lucide-user-round', to: '/settings/profile' }` and `{ label: 'Voice', icon: 'i-lucide-mic-vocal', to: '/settings/voice' }`, and remove Voice from `mainItems`.
  - `app/pages/settings/bridget.vue`: add a "Self-improvement" `USelect` with items `on` / `review_only` / `off`.
- Create:
  - `app/pages/settings/profile.vue`
  - `app/pages/settings/voice.vue`: move `app/pages/voice.vue` here unchanged.
  - `app/pages/voice.vue`: now just `navigateTo('/settings/voice', { redirectCode: 301 })` in `definePageMeta` middleware or an equivalent.
  - `app/lib/config/profile-starter.ts`
  - `server/api/settings/self-improvement.get.ts`
  - `server/api/settings/self-improvement.put.ts`
  - tests: `app/lib/config/source.test.ts` (extend), `test/self-improvement-routes.test.ts`

**Interfaces:**
- Consumes: the Task 2 API; `getSelfImprovementMode`/`setSelfImprovementMode` from Task 1.
- The profile page mirrors `app/pages/skills/[slug].vue`:
  - `useConfigSource('profile', 'profile')`;
  - `<MarkdownConfigEditor v-model="content" view-mode-cookie="mm.config.viewMode" default-view-mode="split" @save="save" />`, rendered only once `loaded` is true (skeleton until then);
  - `<ConfigRevisionsPanel kind="profile" slug="profile" :dirty="dirty" @reverted="reload" />`;
  - ⌘S saves;
  - a token meter `{{ tokens }} / 1500` using `UProgress`, turning `warning` when over budget, with a `UAlert` "Only the first 1,500 tokens are used in Bridget's prompt";
  - `profileStarterMarkdown()` inserted when the server content is empty and not dirty.

- [ ] **Step 1: Failing unit tests.** `configEndpoints('profile','x')` maps to the profile endpoints. The self-improvement routes are session-only and accept only the three values (400 otherwise).
- [ ] **Step 2: Implement.** The starter template:
  ```md
  # About Tony

  ## How I like answers
  -

  ## What a good brief looks like
  -

  ## Routines
  -

  ## Things to avoid
  -
  ```
- [ ] **Step 3: Browser-validate** with `playwright-cli` on a spare port. Set `BETTER_AUTH_URL` to match the port.
  1. Settings → Profile loads the starter. Edit, then ⌘S. Reload and the edit persists. The revision shows in the panel; revert works. The meter updates.
  2. `/voice` redirects to `/settings/voice` and the studio renders. The main nav has no Voice entry, and Settings shows Profile and Voice.
  3. Settings → Bridget: set the mode to "review only", reload, and it persists; then restore it.
  4. Restore the real profile row to its original content via its original hash.
  Put screenshots in the scratchpad and kill only your own PID.
- [ ] **Step 4:** Run the gates. Commit `feat(self-improve): Settings → Profile and Voice, self-improvement mode`.

---

### Task 4: Engagement signals

**Files:**
- Create: `server/lib/agent/signals/classify.ts`, `server/lib/agent/signals/write.ts`, `test/signals-classify.test.ts`, `test/signals.db.test.ts`
- Modify:
  - `server/lib/agent/jobs/outcome.ts`: when a job run finishes non-silently with an `assistantMessageId`, call `openObservation(run)`.
  - `server/lib/agent/runtime/queue.ts`: after a `trigger:'user'` enqueue on main, call `noteUserReply({ conversationId, text, at })` fire-and-forget.
  - `server/lib/channels/inbound.ts`: a tapback that `resolveTapback` didn't consume as an approval goes to `noteTapback(ev)`.
  - `server/lib/channels/approvals.ts`: `resolveTapback` returns whether it matched an approval, so the non-approval branch can call `noteTapback`.

**Interfaces:**
- Produces:
  ```ts
  export type SignalKind = 'replied' | 'tapback_positive' | 'tapback_negative' | 'said_stop' | 'said_thanks' | 'ignored'
  export const OBSERVATION_WINDOW_MS = 2 * 60 * 60 * 1000
  export function classifyReplyText(text: string): ('said_stop' | 'said_thanks')[]
  export function tapbackSignal(t: Tapback): 'tapback_positive' | 'tapback_negative' | null   // love/like/laugh/emphasize → positive; dislike → negative; question → null
  export async function openObservation(run: { id: string; jobId: string | null; assistantMessageId?: string | null }): Promise<void>   // no-op without jobId/messageId; records nothing yet, the window is derived from the message's created_at
  export async function noteUserReply(i: { conversationId: string; text: string; at: Date }): Promise<number>   // on main only: every job assistant message in main within the window with no 'replied' yet gets 'replied' (+ classified extras); returns rows written
  export async function noteTapback(ev: TapbackEvent): Promise<boolean>   // targetGuid = channel_deliveries.external_id of a job delivery → tapback_* signal
  export async function closeObservations(now?: Date, opts?: { onlyJobIds?: string[] }): Promise<number>   // job messages older than the window with no signal → 'ignored'
  ```
- The stop lexicon is case-insensitive whole words: `stop`, `not useful`, `don't send`, `dont send`, `unsubscribe`, `too many`. The thanks lexicon: `thanks`, `thank you`, `helpful`, `perfect`, `nice`.

- [ ] **Step 1: Failing pure tests.**
  - `classifyReplyText`: "stop sending these" → `['said_stop']`; "thanks!" → `['said_thanks']`; "stopwatch" → `[]`; "Thank you, perfect" → `['said_thanks']`, with no duplicates.
  - `tapbackSignal` covers every Tapback value.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: DB tests.** Use a scratch conversation posing as main via a `mainConversationId` seam on `noteUserReply`, a scratch job and run, and assistant messages with backdated `created_at`.
  - A reply within 2 h → `replied`.
  - A reply after 3 h → nothing.
  - Two replies → a single `replied` (unique index).
  - A stop phrase → both `replied` and `said_stop`.
  - A tapback on a delivery whose `external_id` matches → `tapback_positive`.
  - An approval tapback isn't double-counted.
  - `closeObservations` writes `ignored` for a silent job message and skips one that already has a signal.
  - Cleanup by ids.
- [ ] **Step 4:** Run the gates. Commit `feat(self-improve): engagement signals for job messages`.

---

### Task 5: Reflector core — candidates, transcript, prompt, schema, call

**Files:**
- Create:
  - `server/lib/agent/reflect/candidates.ts`
  - `server/lib/agent/reflect/transcript.ts`
  - `server/lib/agent/reflect/prompt.ts`
  - `server/lib/agent/reflect/schema.ts`
  - `server/lib/agent/reflect/call.ts`
  - `test/reflect-schema.test.ts`
  - `test/reflect-transcript.test.ts`
  - `test/reflect-candidates.db.test.ts`

**Interfaces:**
- Consumes: `chat('reasoning', messages, { temperature: 0.2, maxTokens: 1500 })` from `server/lib/ai/chat.ts`; `listSkills`; `getProfileSource`.
- Produces:
  ```ts
  // schema.ts
  export const ProposalKind = z.enum(['skill.create', 'skill.edit', 'profile.edit', 'job.edit', 'job.disable'])
  export const Proposal = z.object({ kind: ProposalKind, target: z.string().min(1).max(80), content: z.string().max(8000).optional(), reason: z.string().min(1).max(600), confidence: z.number().min(0).max(1), evidence: z.array(z.string().min(3).max(500)).min(1).max(5) })
  export type Proposal = z.infer<typeof Proposal>
  export function parseReflectorOutput(raw: string, allowed: Proposal['kind'][]): { ok: true; proposals: Proposal[] } | { ok: false; error: string }
    // strips ``` fences; takes the first {...} or [...] block; accepts { proposals: [...] } or [...]; zod-validates each item and DROPS invalid items; keeps at most 3; drops kinds not in `allowed`; empty/"none" → ok with []
  // candidates.ts
  export async function threadCandidates(opts?: { now?: Date; limit?: number; onlyConversationIds?: string[] }): Promise<{ conversationId: string; since: Date | null }[]>
    // ≥ 4 messages newer than reflected_through (or all when null), last message ≥ 30 min ago, reflected_through older than 2 h or null; ordered by last message; limit default 5
  export async function markReflected(conversationId: string, through: Date): Promise<void>
  // transcript.ts
  export function buildThreadTranscript(msgs: { id: string; role: string; content: string; toolCalls?: unknown; createdAt: Date }[], opts?: { maxChars?: number }): string
    // "[user] …" / "[bridget] …" / "[tool name → summary]" lines; drops reasoning; keeps the most recent turns up to maxChars (default 24_000)
  // prompt.ts
  export function threadReflectionMessages(i: { transcript: string; skills: { name: string; description: string; source: 'human' | 'agent' }[]; profile: string; recentRejections: string[] }): ChatMessage[]
  export function jobsReflectionMessages(i: { jobs: { slug: string; content: string; source: string; signals: Record<string, number>; snippets: string[] }[] }): ChatMessage[]
  // call.ts
  export async function callReflector(messages: ChatMessage[], allowed: Proposal['kind'][], deps?: { chatFn?: typeof chat }): Promise<{ ok: true; proposals: Proposal[] } | { ok: false; error: string }>
  ```
- The system prompt (in `prompt.ts`, verbatim intent): "You review Bridget's recent work and propose at most 3 improvements. Most threads warrant NONE, and an empty list is the right answer. Propose a skill only for a reusable procedure she worked out or was corrected into; propose a profile edit only for a preference Tony stated or clearly showed. Every proposal must include 1–5 exact quotes copied verbatim from the transcript as evidence. Never propose tools, permissions, commands to run, or secrets. Output JSON only: {\"proposals\": [...]}." For profile edits, `content` is the FULL new profile. For skill edits it is the full new skill file. For jobs it is the full new job file; `job.disable` has no content.

- [ ] **Step 1: Failing tests for `parseReflectorOutput`.**
  - Fenced JSON → parsed.
  - Prose then JSON → parsed.
  - A trailing-comma or garbage reply → ok with `[]`, or `ok: false` for total garbage. Pick `ok: false` for unparsable input and assert it.
  - `{ "proposals": [] }` → ok `[]`.
  - 5 valid items → 3.
  - A disallowed kind → dropped.
  - An item missing evidence → dropped.
  - Confidence 1.3 → dropped.
- [ ] **Step 2:** Transcript tests: roles are labelled, a tool call is summarised, reasoning is excluded, the oldest turns are cut first at `maxChars`.
- [ ] **Step 3:** Candidate DB tests with scratch conversations and backdated messages via the `onlyConversationIds` seam:
  - 3 new messages → none;
  - 4 new but last 10 min ago → none;
  - 4 new, 40 min idle → included;
  - reflected 1 h ago → excluded;
  - `markReflected` advances the watermark.
- [ ] **Step 4:** `callReflector` with a stubbed `chatFn` passes the output through `parseReflectorOutput`. When `chatFn` throws, it returns `ok: false`.
- [ ] **Step 5:** Run the gates. Commit `feat(self-improve): reflector core — candidates, transcript, prompt, parsing`.

---

### Task 6: The gate (pure) + Jev check

**Files:**
- Create:
  - `server/lib/agent/reflect/gate.ts`
  - `server/lib/agent/reflect/similarity.ts`
  - `server/lib/agent/reflect/jev.ts`
  - `test/reflect-gate.test.ts`
  - `test/reflect-jev.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // similarity.ts
  export function normaliseText(s: string): string            // lowercase, collapse whitespace, strip punctuation
  export function similarity(a: string, b: string): number      // Jaccard over word 3-shingles of normaliseText (1 when both empty)
  // gate.ts
  export type Route = 'auto' | 'review' | 'dropped'
  export interface GateContext {
    mode: SelfImprovementMode
    input: string                                   // the exact text the reflector saw
    targetAuthor: 'human' | 'agent' | 'missing'     // skill source / job source / 'human' for the profile
    recentRejections: { kind: string; target: string; content: string }[]
    validate: (p: Proposal) => string | null        // null = valid, else a reason (existing parsers/validators, skill size, profile budget)
    autoAppliedToday: number
    targetChangedWithin24h: boolean
    jev: JevVerdict | 'unavailable'
  }
  export interface GateResult { route: Route; reasons: string[] }  // reasons explain every downgrade/drop
  export function gate(p: Proposal, ctx: GateContext): GateResult
  export const AUTO_PER_DAY = 5
  export const SIMILARITY_REJECT = 0.8
  export const SKILL_MAX_BYTES = 4096
  export const SENSITIVE = /\b(exec|shell|command line|terminal|sudo|rm -rf|password|secret|token|api key|credential|delete|drop table)\b/i
  // jev.ts
  export interface JevVerdict { answers: Record<string, number>; risky: boolean; model: string }
  export const JEV_BUMP = 0.6
  export const REFLECT_JEV_QUESTIONS: Record<'skill' | 'profile' | 'job', Record<string, { type: 'noul'; instructions: string; unwanted: 'high' | 'low' }>>
  export async function jevCheck(p: Proposal, evidence: string, deps?: { ask?: typeof askJev; cfg?: JevConfig | null }): Promise<JevVerdict | 'unavailable'>
  ```
- Gate order, following spec §5:
  1. mode `off` → dropped (`mode_off`);
  2. every evidence quote must pass `normaliseWs(input).includes(normaliseWs(quote))`, else dropped (`evidence`). `normaliseWs` only collapses whitespace; case and punctuation stay exact;
  3. rejection memory: same kind + target with `similarity(content, rejected.content) >= 0.8` → dropped (`rejected_recently`);
  4. `validate(p)` → dropped (`invalid: …`); `targetAuthor === 'missing'` for an edit → dropped (`target_missing`);
  5. tier: auto for `skill.create`; `skill.edit` or `job.edit` when `targetAuthor === 'agent'`; everything else is review (`profile.edit`, `job.disable`, edits to human-authored targets);
  6. `SENSITIVE` matching skill content → review (`sensitive`);
  7. Jev: `'unavailable'` → review (`jev_unavailable`); `risky` → review (`jev_risky`);
  8. caps: `autoAppliedToday >= 5` or `targetChangedWithin24h` → review (`cap`);
  9. mode `review_only` turns `auto` into review (`review_only`).
- Jev questions are observable only:
  - **skill:** `one_off` = "Does this describe fixing one specific situation rather than a procedure that applies again?" (unwanted high); `time_bound` = "Is this tied to a specific date, event or temporary state?" (unwanted high).
  - **profile:** `inferred` = "Is this preference inferred or guessed rather than stated by Tony in the evidence?" (unwanted high); `passing` = "Does the evidence describe a passing mood or one-off situation?" (unwanted high).
  - **job:** `unrelated` = "Does the evidence describe something other than Tony's reaction to this job's messages?" (unwanted high).
  - `risky` = any unwanted-high answer ≥ 0.6. The Jev `state` string is `kind`, `target`, content, reason and evidence joined with blank lines.

- [ ] **Step 1: Failing gate tests,** one per rule plus ordering. For example:
  ```ts
  const base: GateContext = { mode: 'on', input: 'Tony: always file receipts under /finance/receipts', targetAuthor: 'missing', recentRejections: [], validate: () => null, autoAppliedToday: 0, targetChangedWithin24h: false, jev: { answers: {}, risky: false, model: 'jev' } }
  const p: Proposal = { kind: 'skill.create', target: 'file-receipts', content: '# File receipts\nPut receipts in /finance/receipts.', reason: 'Tony corrected it', confidence: 0.8, evidence: ['always file receipts under /finance/receipts'] }
  it('auto for a clean new skill', () => expect(gate(p, base).route).toBe('auto'))
  it('drops paraphrased evidence', () => expect(gate({ ...p, evidence: ['file receipts in finance'] }, base).route).toBe('dropped'))
  it('whitespace differences still match', () => expect(gate({ ...p, evidence: ['always  file receipts\nunder /finance/receipts'] }, base).route).toBe('auto'))
  it('profile edits always review', () => expect(gate({ ...p, kind: 'profile.edit', target: 'profile' }, { ...base, targetAuthor: 'human' }).route).toBe('review'))
  it('Jev never promotes a review', () => expect(gate({ ...p, kind: 'job.disable', target: 'heartbeat' }, { ...base, targetAuthor: 'human' }).route).toBe('review'))
  it('Jev risky demotes auto', () => expect(gate(p, { ...base, jev: { answers: { one_off: 0.7 }, risky: true, model: 'jev' } }).route).toBe('review'))
  it('Jev unavailable demotes auto', () => expect(gate(p, { ...base, jev: 'unavailable' }).route).toBe('review'))
  it('cap demotes the 6th auto', () => expect(gate(p, { ...base, autoAppliedToday: 5 }).route).toBe('review'))
  it('review_only demotes', () => expect(gate(p, { ...base, mode: 'review_only' }).route).toBe('review'))
  it('off drops', () => expect(gate(p, { ...base, mode: 'off' }).route).toBe('dropped'))
  it('sensitive skill → review', () => expect(gate({ ...p, content: 'Run the shell command…' }, base).route).toBe('review'))
  it('recently rejected similar → dropped', () => expect(gate(p, { ...base, recentRejections: [{ kind: 'skill.create', target: 'file-receipts', content: p.content! }] }).route).toBe('dropped'))
  ```
  Also test `similarity` ('a b c d' vs itself → 1; disjoint → 0).
- [ ] **Step 2: Jev tests** with a stubbed `ask`:
  - 0.7 on an unwanted-high question → risky;
  - all low → not risky;
  - `cfg: null` → `'unavailable'`;
  - `ask` throws → `'unavailable'`.
- [ ] **Step 3:** Implement and pass. Mutation-check each rule by removing it.
- [ ] **Step 4:** Commit `feat(self-improve): the proposal gate and one-way Jev check`.

---

### Task 7: Passes, apply, `self-improvement` review kind

**Files:**
- Create:
  - `server/lib/agent/reflect/apply.ts`
  - `server/lib/agent/reflect/thread-pass.ts`
  - `server/lib/agent/reflect/jobs-pass.ts`
  - `test/reflect-apply.db.test.ts`
  - `test/reflect-passes.db.test.ts`
- Modify:
  - `server/api/review/kinds.ts`: add `approveHandlers['self-improvement']` and `rejectHandlers['self-improvement']`.
  - `shared/types/live.ts`: add `'agentImprovement'`, and map it in `app/utils/live-dispatch.ts` to invalidate `['review']` and `['agentImprovement']`.

**Interfaces:**
- Consumes: Tasks 1–6; `createSkill`/`saveSkillSource`/`getSkillSource`/`listSkills` (skills store); `getJob`/`saveJob`/`setJobEnabled` (jobs store); `getProfileSource`/`saveProfileSource`; `jevCheck`; `gate`; `closeObservations` (Task 4).
- Produces:
  ```ts
  export async function processProposal(p: Proposal, src: { pass: 'thread' | 'jobs'; conversationId: string | null; runIds: string[]; input: string; expectedHash: string | null }): Promise<{ improvementId: string; status: 'applied' | 'pending_review' | 'dropped' | 'conflict' }>
    // builds GateContext (target author, recent rejections, validation, today's auto count in the agent timezone, 24h target change, jev), runs gate, records agent_improvements, then:
    //   auto → applyImprovement (CAS) → applied | conflict(→ review item)
    //   review → review_queue row { targetKind: 'improvement', targetId: improvementId, kind: 'self-improvement', proposed: { improvementId, proposal, reasons, jev, currentContent } } → pending_review
  export async function applyImprovement(improvementId: string, actor: 'agent' | 'human'): Promise<{ ok: true; revisionId: string | null } | { ok: false; conflict: { content: string; contentHash: string } }>
    // skill.create → createSkill-from-markdown (saveSkillSource(slug, content, null, 'agent')); skill.edit → saveSkillSource(slug, content, expectedHash, actor); job.edit → saveJob(slug, content, expectedHash, actor); job.disable → setJobEnabled(slug, false, actor, null, expectedHash); profile.edit → saveProfileSource(content, expectedHash, actor, { improvementId })
    // every write passes improvementId through to recordRevision
  export async function runThreadPass(opts?: { now?: Date; onlyConversationIds?: string[]; chatFn?: typeof chat; jev?: typeof jevCheck }): Promise<{ threads: number; proposals: number }>
  export async function runJobsPass(opts?: { now?: Date; onlyJobSlugs?: string[]; chatFn?: typeof chat; jev?: typeof jevCheck }): Promise<{ jobs: number; proposals: number }>
    // closeObservations first; jobs with < 5 signals in 14 days are skipped
  ```
- Review handlers:
  - **approve:** `applyImprovement(id, 'human')`, then status `applied`. A conflict returns a 409-style `{ summary: 'Changed since proposed — reload the review' }` and the item stays pending with `currentContent` refreshed.
  - **reject:** status `rejected` and `decided_at` set.

- [ ] **Step 1: Apply DB tests** (scoped slugs `simp-`; snapshot/restore the profile).
  - `skill.create` applies with an agent revision carrying `improvementId`.
  - A `skill.edit` of a human skill goes to review; approving it applies with actor `human`.
  - CAS conflict: edit the skill after the proposal and before the apply → `conflict` → review item with fresh content, no overwrite (Review Focus 3).
  - `profile.edit` goes to review; approve updates the profile.
  - Reject records `rejected`, and the same proposal next time is `dropped` (`rejected_recently`).
  - `job.disable` goes to review.
  - The 6th auto within a day goes to review.
- [ ] **Step 2: Pass DB tests** with a stubbed `chatFn` returning fixed JSON and a stubbed `jev`.
  - The thread pass advances the watermark on zero proposals and on success.
  - It retries once after a `chatFn` failure, then advances with no proposals (Review Focus 2). Track retries in memory keyed by conversation id; one retry per process is acceptable.
  - The jobs pass skips a job with 4 signals and processes one with 5.
  - Nothing ever touches rows outside the seams.
- [ ] **Step 3:** Run the gates. Commit `feat(self-improve): reflection passes, apply with provenance, self-improvement review kind`.

---

### Task 8: Scheduled tasks + eval harness

**Files:**
- Create: `server/tasks/reflect-threads.ts`, `server/tasks/reflect-jobs.ts`, `scripts/reflect-eval.ts`, `scripts/data/reflect-eval.jsonl`, `test/reflect-tasks.test.ts`
- Modify: `nuxt.config.ts` `scheduledTasks` (`'*/15 * * * *'` += `reflect-threads`; `'10 * * * *'` += `reflect-jobs`); `package.json` script `reflect:eval`

**Interfaces:**
- `reflect-threads`: `if (await getSelfImprovementMode() === 'off') return`, then `runThreadPass()` inside `withSpan({ kind: 'job', name: 'reflect-threads' })` plus `recordJobSummary`, following `server/tasks/summarize-threads.ts`.
- `reflect-jobs` runs hourly and does the work only when the hour in `getDefaultTimezone()` is 3 and the hour's minute is past 30. Nitro cron is in UTC, so the local-hour check is what makes it fire at 03:30 local. It keeps a `settings` key `reflect_jobs_last_date` (YYYY-MM-DD, agent timezone) so it runs at most once a day.
- `shouldRunJobsPass(now: Date, tz: string, lastDate: string | null): boolean` is pure and exported.
- The eval script:
  - reads the JSONL rows `{ transcript, expect: { kind, target } | null }`;
  - runs `callReflector` for real, with no gate and no DB writes;
  - prints precision on the `null` rows (proposals made where none were expected) and hit rate on the rest;
  - exits 0 regardless;
  - is documented in the handover.

- [ ] **Step 1:** `shouldRunJobsPass` tests, including across DST: 03:40 Chicago with lastDate yesterday → true; 03:10 → false; already ran today → false; 04:05 not yet run today → true, because a missed tick still runs later that day.
- [ ] **Step 2:** Write the 20 eval rows by hand. Include 10 with expected `null`: small talk, a one-off lookup, a failed attempt, a mood. The other 10 each expect a skill or profile proposal and contain an explicit correction or stated preference.
- [ ] **Step 3:** Run the gates. Commit `feat(self-improve): reflection tasks and eval harness`.

---

### Task 9: Review choices, the review-decisions service, `list_reviews` / `decide_review`

**Files:**
- Create:
  - `shared/review/choices.ts`
  - `server/services/review-decisions.ts`
  - `server/lib/agent/tools/reviews.ts`
  - `app/components/review/SelfImprovementCard.vue`
  - `test/review-choices.test.ts`
  - `test/review-decisions.db.test.ts`
  - `test/review-tools.test.ts`
- Modify:
  - `server/api/review/[id]/approve.post.ts`, `reject.post.ts`, `resolve.post.ts`: become thin wrappers over `decideReview`, keeping their current response shapes.
  - `app/pages/review.vue`:
    - conflict labels and actions come from `reviewChoices`, removing the inline `CONFLICT_TOAST`/`conflictActions` duplication while keeping the same labels;
    - a `v-else-if="item.kind === 'self-improvement'"` branch renders `ReviewSelfImprovementCard`.
  - `server/lib/agent/tools.ts`: spread `listReviewsTool` into `agentTools`.
  - `server/lib/agent/profile.ts`: add `decideReviewTool` to `bridgetProfile.tools` only, never to `agentTools`.
  - `server/lib/agent/runtime/gate.ts`: `list_reviews` is read-class. `decide_review` is `dangerous`, so `classifyForHeadless` already excludes it; assert that in a test.

**Interfaces:**
- Produces:
  ```ts
  // shared/review/choices.ts
  export interface ReviewChoice { id: string; label: string; description: string; tone?: 'primary' | 'neutral' | 'error' }
  export function reviewChoices(item: { kind: string }): ReviewChoice[]
    // memory-supersede / memory-contradict → keep-both "Keep both", archive-old "Archive old (accept)", archive-new "Archive new", archive-both "Archive both"   (labels exactly as review.vue shows today)
    // memory-unreviewed → approve "Keep", reject "Forget"
    // every other kind → approve "Approve", reject "Reject"
  // server/services/review-decisions.ts
  export type DecisionResult = { ok: true; summary: string; undoToken?: string; applied?: unknown } | { ok: false; reason: 'not_pending' | 'unknown_kind' | 'invalid_choice' | 'conflict'; message: string }
  export async function decideReview(id: string, choice: string): Promise<DecisionResult>
    // loads the item (memory-unreviewed: memories row); validates choice ∈ reviewChoices(item); approve/reject → approveHandlers/rejectHandlers; conflict choices → the extracted resolve logic; memory-unreviewed → existing memory review/forget service
  export async function listPendingReviews(opts: { kind?: string; limit?: number }): Promise<{ id: string; kind: string; summary: string; createdAt: string; detail: unknown; choices: ReviewChoice[] }[]>
  // tools/reviews.ts
  export const listReviewsTool: AgentTool   // name 'list_reviews', kind 'read', schema { kind?: string, limit?: number(1..50) default 20 }
  export const decideReviewTool: AgentTool  // name 'decide_review', kind 'destructive', dangerous: true, schema { id: uuid-or-string, choice: string, note?: string }, describeApproval: ({ id, choice }) → { tool: 'decide_review', command: `${choice} — ${summary}` } (summary fetched synchronously from a cache filled by list, or the id if absent)
  ```
- Behaviour:
  - `decide_review` returns `DecisionResult` messages as its result and never throws.
  - A headless run can't reach it: it isn't in any headless registry, because dangerous tools are excluded.
  - `describeApproval` is synchronous. When the summary isn't cached, the approval text uses the choice plus the item id. That is acceptable, and the approval card also shows the args.

- [ ] **Step 1: Failing tests.**
  - `reviewChoices`: each kind gives the right ids and labels, with conflict labels matching the strings currently in review.vue.
  - The `decideReview` DB tests use scoped review_queue rows of kinds `agent-action` (with a harmless replay target), `memory-supersede` on scratch memories, and `self-improvement` from Task 7. They cover: approve, reject and each conflict resolution route to the same effect as the page; an invalid choice → `invalid_choice` with no change; a second decision → `not_pending` (Review Focus 4); an unknown kind → `unknown_kind`.
- [ ] **Step 2: Tool tests.**
  - `list_reviews` includes `choices` per item.
  - `decide_review` is absent from `mcpToolNames()` and from `agentTools`, and present in `bridgetProfile.tools`.
  - `classifyForHeadless(decideReviewTool) === 'exclude'`.
  - With a denying approval hook the handler never runs: use `buildAiTools` with `requestApproval` resolving `{ approved: false }` and assert no DB change.
- [ ] **Step 3:** Refactor the three routes onto `decideReview`. The existing review route tests must stay green unchanged.
- [ ] **Step 4:** `SelfImprovementCard.vue`: kind badge, target, a line diff of current → proposed (reuse the `lineDiff` helper from `app/lib/config/line-diff.ts`), reason, confidence, evidence quotes with a link to the source thread (`/agent?c=<id>`), Jev answers as small badges, and Approve/Reject from `reviewChoices`.
- [ ] **Step 5: Browser-validate** with `playwright-cli`. Insert one scoped `self-improvement` review row plus a scratch skill through a test script; approve it; confirm the skill changed and the card cleared; then clean up. Memory conflict cards still show the four actions.
- [ ] **Step 6:** Run the gates. Commit `feat(review): shared review choices, decision service, list_reviews and decide_review tools`.

---

### Task 10: `list_improvements`, digest seed, "learned" badge

**Files:**
- Create: `server/lib/agent/tools/improvements.ts`, `test/improvements-tool.db.test.ts`
- Modify:
  - `server/lib/agent/tools.ts` (spread `improvementTools`);
  - `server/lib/agent/runtime/gate.ts` (read class needs no entry, but confirm);
  - `server/lib/agent/jobs/seeds.ts` (add `self-improvement-digest`);
  - `server/lib/agent/jobs/store.ts` (`SEED_JOB_SLUGS` + install);
  - `app/components/config/RevisionsPanel.vue` (a "learned" `UBadge` plus a source-thread link when a revision has `improvementId`; the revisions API returns `improvementId` and the improvement's `sourceConversationId`);
  - the skills/jobs/profile revisions routes, which join `agent_improvements` for `sourceConversationId`.

**Interfaces:**
- `list_improvements({ since?: string ISO, limit?: number = 30 })` → `{ items: { id, kind, target, status, reason, revisionId, createdAt, link: string | null }[], pendingReview: number }`. `since` defaults to the start of today in the agent timezone. The link is `/skills/<slug>` for skills, `/jobs/<slug>` for jobs, `/settings/profile` for the profile, and `/review` when pending.
- Seed `self-improvement-digest`:
  ```md
  ---
  trigger: cron 30 21 * * *
  context: light
  deliver: [auto]
  enabled: false
  ---
  Call list_improvements for today. If there are no applied changes and nothing pending review, reply NO_REPLY.
  Otherwise give Tony a short digest: each change you made to yourself today (one line, with its link so he can undo it), then how many proposals are waiting in /review.
  ```
  The digest seed installs on boot via `installSeedJobs` and is not part of `upgradeSeedJobs`' V1 set. Test that the four existing seeds are unaffected.

- [ ] **Step 1:** Failing tests:
  - `list_improvements` returns today's rows (scoped) with correct links and pending count;
  - the seed parses and is disabled;
  - `installSeedJobs` installs it once;
  - the revisions API returns `improvementId`/`sourceConversationId` for a reflection revision.
- [ ] **Step 2:** Implement. Browser-check a skill page showing the "learned" badge on a reflection revision (scoped scratch skill), then clean up.
- [ ] **Step 3:** Run the gates. Commit `feat(self-improve): list_improvements, digest seed job, learned badge`.

---

### Task 11: Acceptance, docs, handover

**Files:**
- Create: `docs/wiki/self-improvement.md`, `docs/handovers/2026-09-30-bridget-self-improvement.md`
- Modify: `docs/wiki/agent-skills.md`, `docs/wiki/agent-jobs.md`, `docs/wiki/memory.md` (the review tools), `docs/wiki/README.md`, `docs/superpowers/plans/00-roadmap.md` (row 76)

- [ ] **Step 1:** All gates green; record the counts.
- [ ] **Step 2: Acceptance with `playwright-cli`, dev on a spare port, real model runs allowed on scratch threads.**
  1. **Correction becomes a skill.** In a scratch thread, correct Bridget: "no — always put receipts in /finance/receipts". Run the thread pass by hand for that conversation through the seam; this is the one real reflector call. Record whatever it proposes. Either a `skill.create` auto-applies, with the learned badge showing, or it routes to review; either is acceptable, as long as the evidence check passes.
  2. **Stated preference becomes a profile proposal.** State "I prefer bullet points over paragraphs" and confirm a `profile.edit` review item appears. Approve it in `/review`, then confirm Settings → Profile shows the change with its revision.
  3. **Review tools in chat.** Ask Bridget "what's in my review queue?". She calls `list_reviews` and shows the choices. Ask her to approve one; the approval card appears. Deny it, and nothing changes.
  4. **Voice move.** `/voice` redirects to `/settings/voice`.
  5. **Mode off.** With self-improvement set to off, the thread pass does nothing.
  6. **Cleanup.** Scratch skills, profile edits, review rows and improvements are deleted or restored. Report counts before and after. The seed jobs stay disabled.
- [ ] **Step 3:** Run the eval script once and record precision and hit rate in the handover.
- [ ] **Step 4:** Docs.
  - The wiki page covers: evidence → reflector → gate → apply/review; the Jev questions; signals; tasks and timing; the review tools and their confirmation rule; operational SQL.
  - The handover uses frontmatter like the cycle-75 handover, with migration 0063 and `migrations_run_on_prod: false`, plus every ledger ruling.
  - Update the roadmap row.
- [ ] **Step 5:** Commit `docs(cycle-76): self-improvement wiki, handover, roadmap`.

---

## Self-review notes (planning rulings)

- **Actor values stay `'human' | 'agent' | 'system'`.** The spec's `agent:reflection` is represented by `actor: 'agent'` plus a non-null `improvement_id` on the revision (Task 1). The UI's "learned" badge keys off `improvement_id`, so no column widening is needed.
- **The Nitro cron is UTC,** so the 03:30 local nightly pass is an hourly task with a local-hour check and a once-a-day marker (Task 8).
- **Structured output uses `chat('reasoning')` plus zod,** with tolerant JSON extraction. The repo has no `generateObject` precedent.
- **`memory-unreviewed` is a synthetic review kind with memories-table ids.** `reviewChoices` and `decideReview` handle it through the existing memory review/forget service (Task 9).
- **Engagement tapbacks** reuse the cycle-75 tapback routing. `resolveTapback` now reports whether it consumed the tapback as an approval, so the tapback isn't double-counted (Task 4).
