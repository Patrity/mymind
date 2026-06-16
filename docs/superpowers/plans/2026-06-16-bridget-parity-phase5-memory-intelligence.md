# Phase 5 — Enrichment Tuning + Memory Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make enrichment produce higher-signal memories with rich provenance, and add a memory **relationship graph** so the system tracks supersession and contradiction — auto-resolving confident refinements and routing contradictions/uncertain calls to the review queue. Then run the enrichment sweep over the 390 imported sessions.

**Architecture:** Tune the enrichment selector + transcript + prompt (Part F). Add `memories.superseded_by` + a `memory_relations` table (Part G). A `relationship-judge` (`server/lib/ai/memory-judge.ts`) classifies a new candidate against its cosine-near existing memories (duplicate / refines / contradicts / unrelated). A new `resolveEnrichedMemory` orchestrates: exact-hash→merge; near→judge→{merge | auto-supersede(+archive+edge) | review-supersede | contradict(+edge+review) | insert}. The enrichment loop calls it (manual MCP/REST saves keep the cheap `createMemory`). Conflicts ride the existing `review_queue` + `/review` UI; the memory detail surfaces provenance + relations.

**Tech Stack:** Drizzle + pgvector, the AI registry (`chat`, `embedOne`), the existing `dedupDecision`/`createMemory`/`searchMemories`, the generic `review_queue`, vitest, Nuxt UI v4.

**Scope:** Phase 5 of 5 (Parts F + G) — completes cycle 13. Branch `feat/bridget-parity`. No external deps (uses the imported data + the AI rig). The judge runs in the ENRICHMENT path only.

**Conventions:** pure-function vitest; migrations `pnpm db:generate` (+ hand-append index SQL if needed); gates typecheck + test (+ build for UI); `publishChange`; `.vue` = Nuxt UI v4 + semantic tokens. Memory model already has `evidence` jsonb, `reviewed_at`, `archived_at`, `confidence`, `project`, `session_id` (see `server/db/schema/memories.ts`); dedup is `server/services/memory-dedup.ts` (`dedupDecision`); the enrichment loop is `server/services/memory-enrich.ts`; per-candidate persist is `createMemory` in `server/services/memory.ts`.

---

## File structure
**Create:** `server/db/schema/memory-relations.ts`; `server/lib/ai/memory-judge.ts` (+ pure `parseJudgement`); `server/services/memory-resolve.ts` (`resolveEnrichedMemory`); `test/memory-judge.test.ts`; `test/memory-enrich-prompt.test.ts`.
**Modify:** `server/db/schema/memories.ts` (+`supersededBy`); `server/db/schema/index.ts`; `server/lib/ai/memory-extract.ts` (`MemoryCandidate` + parse provenance); `server/services/memory-enrich.ts` (selector + transcript + prompt + call `resolveEnrichedMemory`); `server/services/memory.ts` (export a small insert helper if needed for reuse); `shared/types/memory.ts` (+ relations/provenance in DTO); `server/api/review/[id]/*` (resolve memory-conflict kinds); `app/pages/review.vue` (render conflict items); `app/pages/memories.vue` (provenance + relations).

---

## Task 1: Schema — `superseded_by` + `memory_relations`

**Files:** Modify `server/db/schema/memories.ts`, `index.ts`; Create `server/db/schema/memory-relations.ts`; Generated `0018_*.sql`.

- [ ] **Step 1: memories** — add after `sessionId` (before `enrichedAt`):
```typescript
  supersededBy: uuid('superseded_by'),
```
- [ ] **Step 2: create `server/db/schema/memory-relations.ts`:**
```typescript
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, real, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const memoryRelations = pgTable('memory_relations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  fromId: uuid('from_id').notNull(),   // the newer / superseding memory
  toId: uuid('to_id').notNull(),       // the older / affected memory
  type: text('type').notNull(),        // supersedes | contradicts | duplicate-of
  confidence: real('confidence'),
  status: text('status').notNull().default('active'), // active | resolved
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true })
}, (t) => [
  index('memory_relations_from_idx').on(t.fromId),
  index('memory_relations_to_idx').on(t.toId),
  index('memory_relations_type_idx').on(t.type),
  uniqueIndex('memory_relations_edge_uidx').on(t.fromId, t.toId, t.type)
])
export type MemoryRelation = typeof memoryRelations.$inferSelect
```
Export from `index.ts`: `export * from './memory-relations'`.
- [ ] **Step 3: generate + migrate** — `pnpm db:generate` → `0018_*.sql` (additive: 1 ADD COLUMN + CREATE TABLE; no special index SQL needed — all btree/unique are drizzle-emittable). `pnpm db:migrate`; `pnpm typecheck` (0).
- [ ] **Step 4: commit** — `git add server/db/schema server/db/migrations && git commit -m "feat(memory): superseded_by + memory_relations table (0018)"`

---

## Task 2: Enrichment tuning (selector + transcript + prompt + provenance fields)

**Files:** Modify `server/lib/ai/memory-extract.ts`, `server/services/memory-enrich.ts`; Create `test/memory-enrich-prompt.test.ts`.

- [ ] **Step 1: extend `MemoryCandidate` + parse provenance** — in `server/lib/ai/memory-extract.ts`, add to the interface: `evidenceMsgIds?: string[]`, `reasoning?: string`, `quote?: string`. In the per-item map, extract `evidence_msg_ids` (string[]), `reasoning` (string), `quote` (string, ≤280 chars) tolerantly, and **drop candidates with `confidence < 0.3`** (bridget's floor). Add a test in `test/mem-extract-parse.test.ts` (the existing file) for: provenance fields parsed; a `confidence: 0.2` candidate dropped; a `0.3` kept.

- [ ] **Step 2: expand the enrichment prompt** — in `server/services/memory-enrich.ts`, replace `SYSTEM_PROMPT` with a bridget-quality version (atomic durable facts; scope rules — `agent` is most common, `user` conservative, `world` only non-obvious; ≤240 chars each; confidence bands 0.9-1.0 explicit / 0.6-0.8 implied / 0.3-0.5 weak-novel / <0.3 omit; "0 to 8 memories per session is typical"; require per memory `evidence_msg_ids` (the message ids that justify it), a short verbatim `quote`, and `reasoning`). Output STRICT JSON `{"memories":[{scope,content,tags,confidence,evidence_msg_ids,quote,reasoning}]}`. Pass the message **ids** alongside content in the transcript so the model can cite them.

- [ ] **Step 3: tune the selector + transcript** — in `runMemoryEnrichment`:
  - **Selector:** require a real-message floor via a `sql` subquery (role user/assistant, content-or-thinking non-empty, NOT `system_prompt`, NOT `is_sidechain`) `>= 4`; a **grace period** (`sessions.last_active < now() - interval '1 hour'`); **growth ≥ 5** since last enrichment (not any growth); **exclude inactive projects** (`project is null OR project in (select slug from projects where active)`); and **retry errored** sessions when `last_run < now() - interval '24 hours'` (today an error advances the watermark and never retries — fix that). Mirror the `sql`-subquery-in-`where` pattern already in this file.
  - **Transcript/payload:** include each message's `id`, exclude `is_sidechain` + `system_prompt` rows, include `thinking` (capped ~800 chars) and a tool-usage summary (counts per `tool_name` from `tool_events`), head/tail truncate at the existing char limit.
  - **Project inheritance:** load the session's `project` and pass it through (Step into Task 4's `resolveEnrichedMemory`).

- [ ] **Step 4: `test/memory-enrich-prompt.test.ts`** — pure tests on any extracted helper (e.g. a `buildEnrichTranscript(msgs, tools)` that you factor out, asserting it includes ids + thinking + tool summary and excludes sidechain/system_prompt). Keep DB/LLM out.

- [ ] **Step 5: typecheck + test + commit** — `git commit -m "feat(memory): bridget-quality enrichment prompt + tuned selector + provenance fields"`

---

## Task 3: Relationship-judge

**Files:** Create `server/lib/ai/memory-judge.ts`, `test/memory-judge.test.ts`.

- [ ] **Step 1: failing tests** — `test/memory-judge.test.ts` for the pure `parseJudgement(raw, validIds)`:
```typescript
import { describe, it, expect } from 'vitest'
import { parseJudgement } from '../server/lib/ai/memory-judge'

describe('parseJudgement', () => {
  const ids = ['m1', 'm2']
  it('parses verdicts, keeps only known ids + valid relations', () => {
    const r = parseJudgement('{"verdicts":[{"existingId":"m1","relation":"refines","confidence":0.8,"reasoning":"newer"},{"existingId":"zzz","relation":"duplicate","confidence":0.9}]}', ids)
    expect(r).toEqual([{ existingId: 'm1', relation: 'refines', confidence: 0.8, reasoning: 'newer' }])
  })
  it('tolerates fences + clamps confidence; defaults unknown relation to unrelated', () => {
    const r = parseJudgement('```json\n{"verdicts":[{"existingId":"m2","relation":"bogus","confidence":2}]}\n```', ids)
    expect(r[0]).toMatchObject({ existingId: 'm2', relation: 'unrelated', confidence: 1 })
  })
  it('returns [] on garbage', () => { expect(parseJudgement('nope', ids)).toEqual([]) })
})
```
- [ ] **Step 2: implement** — `server/lib/ai/memory-judge.ts`:
```typescript
import { chat } from './chat'

export type Relation = 'duplicate' | 'refines' | 'contradicts' | 'unrelated'
export interface Verdict { existingId: string, relation: Relation, confidence: number, reasoning?: string }

const RELATIONS = new Set<Relation>(['duplicate', 'refines', 'contradicts', 'unrelated'])
const PROMPT = `You compare a NEW candidate memory against EXISTING memories that are semantically near it. For each existing memory, classify its relationship to the NEW one:
- "duplicate": same fact, no new information.
- "refines": the NEW memory is a more current/correct/complete version that should SUPERSEDE the existing one.
- "contradicts": the NEW memory conflicts with the existing one (both can't be true).
- "unrelated": different facts that happen to be near.
Output STRICT JSON only: {"verdicts":[{"existingId":"<id>","relation":"duplicate|refines|contradicts|unrelated","confidence":0.0-1.0,"reasoning":"<short>"}]}. Be conservative: default to "unrelated" unless clear.`

export function parseJudgement(raw: string, validIds: string[]): Verdict[] {
  const valid = new Set(validIds)
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: unknown = null
  try { obj = JSON.parse(s) } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]) } catch { /* */ } } }
  const arr = (obj && typeof obj === 'object' && Array.isArray((obj as Record<string, unknown>).verdicts))
    ? (obj as Record<string, unknown>).verdicts as unknown[] : []
  return arr.flatMap((v): Verdict[] => {
    if (!v || typeof v !== 'object') return []
    const o = v as Record<string, unknown>
    const existingId = typeof o.existingId === 'string' ? o.existingId : ''
    if (!valid.has(existingId)) return []
    const relation: Relation = (typeof o.relation === 'string' && RELATIONS.has(o.relation as Relation)) ? o.relation as Relation : 'unrelated'
    const confidence = typeof o.confidence === 'number' ? Math.min(1, Math.max(0, o.confidence)) : 0.5
    const reasoning = typeof o.reasoning === 'string' ? o.reasoning.slice(0, 400) : undefined
    return [{ existingId, relation, confidence, ...(reasoning ? { reasoning } : {}) }]
  })
}

/** LLM relationship classification. Returns [] on any failure (caller falls back to plain dedup). */
export async function judgeRelations(candidate: string, near: { id: string, content: string }[]): Promise<Verdict[]> {
  if (!near.length) return []
  const user = `NEW:\n${candidate}\n\nEXISTING:\n${near.map(n => `[${n.id}] ${n.content}`).join('\n')}`
  try {
    const raw = await chat('reasoning', [{ role: 'system', content: PROMPT }, { role: 'user', content: user }], { temperature: 0.1, maxTokens: 800 })
    return parseJudgement(raw, near.map(n => n.id))
  } catch { return [] }
}
```
- [ ] **Step 3: run tests + typecheck + commit** — `git commit -m "feat(memory): LLM relationship-judge (duplicate/refines/contradicts)"`

---

## Task 4: Resolution — `resolveEnrichedMemory` + wire into enrichment

**Files:** Create `server/services/memory-resolve.ts`; Modify `server/services/memory-enrich.ts`, and (small) `server/services/memory.ts` if a shared insert helper is cleaner.

- [ ] **Step 1: implement `server/services/memory-resolve.ts`** — orchestrates judge + relations + supersede/archive + review-enqueue. Reuses `embedOne`, `dedupDecision`, the `memories`/`memoryRelations`/`reviewQueue` tables, `publishChange`. Behavior (auto-threshold from `useRuntimeConfig().memoryAutoReviewThreshold`, default 0.75):
  - Embed candidate; fetch exact-hash row + top-K (≤8) cosine-near in the same `(scope, project)` bucket (id + content + embedding), like `createMemory` does.
  - **exact hash** → merge evidence into it (append `{sessionId,msgIds,quote,reasoning,mergedAt}`), return `{action:'duplicate'}`.
  - **no near** → insert fresh memory (with provenance evidence + project + sessionId + confidence + `enrichedAt`), return `{action:'insert'}`.
  - **near present** → `judgeRelations(candidate.content, near)`:
    - if any `duplicate` (conf ≥ 0.6) → merge evidence into that memory, return `{action:'duplicate'}`.
    - else pick the highest-confidence `refines`: if conf ≥ threshold → insert new; `memoryRelations` row `(from=new, to=existing, type='supersedes', confidence, status='active', reason)`; archive existing (`archivedAt=now`, `supersededBy=new`); `publishChange` both; return `{action:'supersede'}`. If conf < threshold → insert new (active) + `reviewQueue` row `{docId: existingId, kind:'memory-supersede', proposed:{newId, existingId, confidence, reasoning, newContent, existingContent}}`; return `{action:'review-supersede'}`.
    - else any `contradicts` → insert new; `memoryRelations` `(from=new, to=existing, type='contradicts', status='active', confidence, reason)`; `reviewQueue` `{docId: existingId, kind:'memory-contradict', proposed:{…}}`; return `{action:'contradict'}`.
    - else (all unrelated) → insert fresh, return `{action:'insert'}`.
  - Factor the "insert a fresh enrichment memory" into a small helper (content/contentHash/embedding/tags/scope/project/sessionId/confidence/evidence/enrichedAt) — reuse `createMemory`'s insert shape; **do NOT re-run the judge from within `createMemory`** (manual saves keep cheap dedup).
- [ ] **Step 2: wire into the enrichment loop** — in `server/services/memory-enrich.ts`, replace the per-candidate `createMemory(...)` call with `resolveEnrichedMemory({ ...candidate, project: session.project, sessionId, evidence: [{ sessionId, msgIds: candidate.evidenceMsgIds, quote: candidate.quote, reasoning: candidate.reasoning, mergedAt: now }] })`. Tally outcomes (inserted/superseded/contradicted/duplicate/review) into the result.
- [ ] **Step 3: tests** — unit-test the pure outcome-selection (factor a `chooseResolution(verdicts, threshold)` pure function returning the action + target id, and test: highest refines auto vs review, contradicts routes to review, all-unrelated→insert, duplicate→merge). Put in `test/memory-judge.test.ts` or a new `test/memory-resolve.test.ts`.
- [ ] **Step 4: typecheck + test + commit** — `git commit -m "feat(memory): resolveEnrichedMemory — provenance, supersede graph, contradiction review-gating"`

---

## Task 5: Review-conflict handling + provenance UI

**Files:** Modify `server/api/review/[id]/*` (or add a resolve endpoint), `app/pages/review.vue`, `shared/types/memory.ts`, `app/pages/memories.vue` (+ `useMemories`/a memory-detail surface).

- [ ] **Step 1: review resolve for memory conflicts** — read the current `server/api/review/[id]/` resolve endpoint(s) + `review.vue`. Extend so an item with `kind in ('memory-supersede','memory-contradict')` can be resolved: **accept** (supersede: archive `existingId`, set its `supersededBy`, mark the relation `resolved`; contradict: archive the user-chosen loser) / **reject/keep-both** (mark relation `resolved`, archive nothing). The resolve action sets `review_queue.status` + the `memory_relations.status='resolved'`/`resolved_at`. Surface the conflict payload (new vs existing content, relation, reasoning) in `review.vue` with accept / keep-both actions, distinct from the existing enrichment-doc items.
- [ ] **Step 2: provenance + relations in the memory DTO** — extend `MemoryDTO` (`shared/types/memory.ts`) with the parsed `evidence` entries already present, plus a `relations` field (supersedes/superseded-by/contradicts, fetched in `getMemory`/`listMemories` via `memory_relations`). Surface in `app/pages/memories.vue`: per memory, show source session link (`/sessions/{sessionId}`), the verbatim `quote` + `reasoning` from evidence, and relation badges (→ supersedes / ← superseded-by / ⚠ contradicts) linking to the related memory. Nuxt UI v4 + semantic tokens.
- [ ] **Step 3: typecheck + build + test + commit** — `git commit -m "feat(memory): review-gated conflict resolution + provenance/relations UI"`

---

## Task 6: Enrichment sweep + gates + E2E + final review

- [ ] **Step 1: static gates** — typecheck 0, test all pass, build OK.
- [ ] **Step 2: enrichment sweep** (dev server, real rig) — trigger `enrich-memories` repeatedly (or let the `*/15` schedule run) over the imported sessions; confirm memories are generated with provenance (`evidence` carries sessionId + msgIds + quote + reasoning; `project` inherited from the session). Check the status tally.
- [ ] **Step 3: relationship E2E** — craft/confirm two cases: (a) enrich a session whose fact **refines** an existing memory → with high judge confidence the old memory is archived + a `supersedes` relation exists + `superseded_by` set; with low confidence a `memory-supersede` review item appears. (b) a **contradicting** fact → both kept, a `contradicts` relation (status active), and a `memory-contradict` review item; resolving it in `/review` archives the chosen loser + marks the relation resolved.
- [ ] **Step 4: provenance UI** — open `/memories`, confirm a memory shows its source session link, quote/reasoning, and any relation badges; `/review` shows the conflict items with accept/keep-both.
- [ ] **Step 5: final review** — dispatch a reviewer over the whole Phase-5 diff: selector tuning correctness, judge integration into the enrichment path (manual saves NOT judged), relation/edge writes, review-resolve transitions, DTO/UI shapes, migration 0018.

---

## Done criteria
- Enrichment yields atomic, scope-correct memories with rich provenance (session + msg_ids + quote + reasoning), project-inherited, on tuned selection (grace, growth≥5, real floor, active-projects, error-retry).
- A new memory that refines an existing one auto-supersedes it (high confidence) or queues a review (low); a contradiction is recorded as a relation + queued; `/review` resolves both; `/memories` shows provenance + relations.
- The judge runs only in enrichment; manual MCP/REST saves keep cheap dedup.
- Imported sessions enriched; all gates green; E2E verified.
- **Cycle 13 COMPLETE** → update roadmap (rows 13 + folded backlog items), wiki (`memory.md`), write the cycle handover.
