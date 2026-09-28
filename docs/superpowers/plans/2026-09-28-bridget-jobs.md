# Bridget Jobs Implementation Plan (cycle 74)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Bridget talk in her main thread on her own through markdown-configured jobs (cron / every / at / event triggers) that Tony or Bridget can edit, and give Skills and Jobs first-class pages.

**Architecture:** Two new tables hold agent config as markdown-with-frontmatter (`agent_skills`, `agent_jobs`); a pure parser derives schedule columns on every save; the cycle-73 worker tick claims due jobs and calls `wake()`. The skills service keeps its public API but swaps storage. The documents page's editor area is extracted into a shared component used by `/documents`, `/skills/[slug]` and `/jobs/[slug]`.

**Tech Stack:** Nuxt 4 / Nitro, TypeScript, Drizzle + Postgres, `croner` (new), `yaml` (new), Vitest, `playwright-cli`.

**Spec:** [`docs/superpowers/specs/2026-09-28-bridget-jobs-design.md`](../specs/2026-09-28-bridget-jobs-design.md)

## Global Constraints

- **`pnpm` only.** Gates: `pnpm test`, `pnpm test:db`, `pnpm typecheck`, `pnpm build`. Lint is not a gate; add no new violations in authored files.
- **DB tests** are `test/*.db.test.ts` with the harness header from `test/agent-runs.db.test.ts` (`process.loadEnvFile('.env')` + `vi.stubGlobal('useRuntimeConfig', …)` before importing `server/db`). The dev DB is shared: scope every query to rows you created; clean up in `afterAll`; never touch the real main conversation or pre-existing skills/jobs.
- **Every new test is mutation-checked** (break the behaviour, watch it go red, restore).
- **Migrations additive only.** Head is `0055`; this cycle adds `0056` via `pnpm db:generate`, hand-checked.
- **Postgres clock** for anything compared with DB timestamps (`sql\`now()\``).
- **No attribution trailers in commits.**
- **Constants (verbatim from the spec):** min interval **5 min**; max **50** enabled jobs; revisions kept **100** per target; `at` jobs pruned **30 days** after firing; auto-disable after **3** consecutive failures; light context = **last 4 turns**; job body ≤ **20,000** chars; UI shows next **5** fire times and last **10** runs.
- **Markdown is the single source of truth** for skills and jobs; derived columns are never edited directly (the enabled switch rewrites the `enabled:` / `active:` line).
- **Browser validation is `playwright-cli`**; load `.claude/skills/browser-testing/SKILL.md` first.

**Planning rulings (deviations from the spec, decided here):**
- **Invalid content is rejected at write time** (UI save and agent tools alike) rather than stored with `parse_error`. `parse_error` is still populated by the boot revalidation pass (e.g. a model removed from the registry), and only that path posts the "job X is invalid" note in main. Reason: the editor autosaves; storing every invalid keystroke-state would spam main with notes.
- **Skills/Jobs pages save explicitly** (Save button + ⌘S), not with the documents autosave, for the same reason.
- **The skills data move runs in a boot plugin** (idempotent), not in SQL: documents store frontmatter as jsonb and the body separately, and rebuilding markdown in SQL is fragile.

## Review Focus

1. **A cron job across a DST change** (e.g. `cron 30 7 * * *` in `America/New_York` on the spring-forward date) fires once at 07:30 local, not twice or never — pinned in Task 2.
2. **The server is down across two scheduled fires** → exactly one catch-up run, then back on schedule — pinned in Task 5.
3. **Bridget edits a job while its run is in progress** → the run finishes on the old prompt; the next fire uses the new content; no duplicate fire — pinned in Task 5 (overlap + reschedule on save).
4. **A skill referenced by a `/skill` slash command after the move** still force-loads its body (cycle-71 skill tier) — pinned in Task 3.
5. **Two tabs editing the same job** → the second save gets a 409 with the current content, never a silent overwrite — pinned in Task 9.

---

## Phase 1 — config storage, skills move, tools, pages

### Task 1: Schema 0056 + dependencies

**Files:**
- Create: `server/db/schema/agent-config.ts`
- Modify: `server/db/schema/index.ts` (export it), `server/db/schema/agent-runs.ts` (`jobId`)
- Create: `server/db/migrations/0056_*.sql` (generated)
- Modify: `package.json` / `pnpm-lock.yaml` (`pnpm add croner yaml`)
- Test: `test/agent-config-schema.db.test.ts`

**Interfaces — Produces:** tables `agentSkills`, `agentJobs`, `agentConfigRevisions`, `agentJobFires`; types `AgentSkillRow`, `AgentJobRow`; `agentRuns.jobId`.

- [ ] **Step 1: Write the failing test**

```ts
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { useDb } from '../server/db'
import { agentSkills, agentJobs, agentJobFires } from '../server/db/schema'
import { inArray } from 'drizzle-orm'

const violates = (name: string) => (e: unknown) => {
  const err = e as { message?: string; cause?: { message?: string } }
  return new RegExp(name).test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`)
}
const skillIds: string[] = []; const jobIds: string[] = []
afterAll(async () => {
  const db = useDb()
  if (jobIds.length) await db.delete(agentJobs).where(inArray(agentJobs.id, jobIds))
  if (skillIds.length) await db.delete(agentSkills).where(inArray(agentSkills.id, skillIds))
})

describe('agent config schema', () => {
  it('skill and job slugs are unique', async () => {
    const [s] = await useDb().insert(agentSkills).values({ slug: 'schema-test-skill', content: 'x', contentHash: 'h' }).returning()
    skillIds.push(s!.id)
    await expect(useDb().insert(agentSkills).values({ slug: 'schema-test-skill', content: 'y', contentHash: 'h2' })).rejects.toSatisfy(violates('agent_skills_slug'))
    const [j] = await useDb().insert(agentJobs).values({ slug: 'schema-test-job', content: 'x', contentHash: 'h' }).returning()
    jobIds.push(j!.id)
    expect(j!.enabled).toBe(false)
    expect(j!.consecutiveFailures).toBe(0)
  })
  it('an event fire is recorded once per (job, key)', async () => {
    const [j] = await useDb().insert(agentJobs).values({ slug: 'schema-test-fires', content: 'x', contentHash: 'h' }).returning()
    jobIds.push(j!.id)
    await useDb().insert(agentJobFires).values({ jobId: j!.id, eventKey: 'k1' })
    await expect(useDb().insert(agentJobFires).values({ jobId: j!.id, eventKey: 'k1' })).rejects.toSatisfy(violates('agent_job_fires_pkey'))
  })
})
```

- [ ] **Step 2: Run** `pnpm test:db test/agent-config-schema.db.test.ts` → FAIL (tables missing).

- [ ] **Step 3: Implement.** `pnpm add croner yaml`. Create `server/db/schema/agent-config.ts`:

```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, integer, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core'

/** Agent skills — markdown with frontmatter is the single source of truth (cycle 74). */
export const agentSkills = pgTable('agent_skills', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  // Derived from `content` on every write — never edited directly.
  name: text('name'),
  description: text('description'),
  whenToUse: text('when_to_use'),
  active: boolean('active').notNull().default(true),
  source: text('source').notNull().default('human'), // 'human' | 'agent'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [uniqueIndex('agent_skills_slug').on(t.slug)])

/** Agent jobs — markdown with frontmatter (trigger, timezone, …) + prompt body. */
export const agentJobs = pgTable('agent_jobs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  source: text('source').notNull().default('human'),
  // Derived on every write.
  enabled: boolean('enabled').notNull().default(false),
  triggerKind: text('trigger_kind'),      // 'cron' | 'every' | 'at' | 'event'
  triggerExpr: text('trigger_expr'),
  timezone: text('timezone'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  parseError: text('parse_error'),
  // Runtime.
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastRunId: uuid('last_run_id'),
  lastOutcome: text('last_outcome'),      // 'spoke' | 'silent' | 'failed' | 'skipped'
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  firedAt: timestamp('fired_at', { withTimezone: true }), // set when an `at` job has fired (pruning)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('agent_jobs_slug').on(t.slug),
  index('agent_jobs_due').on(t.nextRunAt).where(sql`enabled and parse_error is null`)
])

export const agentConfigRevisions = pgTable('agent_config_revisions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  targetKind: text('target_kind').notNull(), // 'skill' | 'job'
  targetId: uuid('target_id').notNull(),
  content: text('content').notNull(),
  actor: text('actor').notNull(),            // 'human' | 'agent' | 'system'
  runId: uuid('run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [index('agent_config_revisions_target').on(t.targetKind, t.targetId, t.createdAt)])

export const agentJobFires = pgTable('agent_job_fires', {
  jobId: uuid('job_id').notNull().references(() => agentJobs.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull(),
  firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [primaryKey({ columns: [t.jobId, t.eventKey], name: 'agent_job_fires_pkey' })])

export type AgentSkillRow = typeof agentSkills.$inferSelect
export type AgentJobRow = typeof agentJobs.$inferSelect
```

In `agent-runs.ts` add `jobId: uuid('job_id')` (plain column; FK `on delete set null` in the migration is optional — add `.references(() => agentJobs.id, { onDelete: 'set null' })` importing from `./agent-config` if it doesn't create a cycle; otherwise leave unconstrained and say so). Export from `index.ts`. `pnpm db:generate`, inspect (additive only), `pnpm db:migrate`.

- [ ] **Step 4: Run** the test → PASS. Mutation: drop the unique index from a scratch generate? Impractical — instead change the second insert's slug and confirm the test fails, restore.
- [ ] **Step 5: Commit** `feat(jobs): schema 0056 — agent_skills, agent_jobs, revisions, event fires; add croner + yaml`.

---

### Task 2: Config parsing and scheduling (pure)

**Files:**
- Create: `shared/utils/frontmatter.ts`, `server/lib/agent/jobs/parse.ts`, `server/lib/agent/jobs/schedule.ts`
- Test: `test/frontmatter.test.ts`, `test/jobs-parse.test.ts`, `test/jobs-schedule.test.ts`

**Interfaces — Produces:**
```ts
// shared/utils/frontmatter.ts
splitFrontmatter(md: string): { data: Record<string, unknown>; body: string; error?: string }
joinFrontmatter(data: Record<string, unknown>, body: string): string
setFrontmatterKey(md: string, key: string, value: unknown): string   // rewrites one key, keeps the rest byte-stable where possible
// parse.ts
export type TriggerKind = 'cron' | 'every' | 'at' | 'event'
export interface JobSpec {
  trigger: { kind: TriggerKind; expr: string }   // expr: cron string | '30m' | ISO | event name
  timezone: string; activeHours: { start: string; end: string } | null
  model: string; thread: 'main' | 'isolated'; context: 'light' | 'full'
  deliver: string[]; enabled: boolean; filter: Record<string, string> | null; body: string
}
export const JOB_BODY_MAX = 20_000
export const MIN_INTERVAL_MS = 5 * 60_000
parseJob(md: string, opts: { defaultTimezone: string; isKnownModel?: (id: string) => boolean }): { ok: true; spec: JobSpec } | { ok: false; error: string }
// schedule.ts
nextRunAt(spec: JobSpec, from: Date): Date | null          // null for 'event' and for a past 'at'
nextFireTimes(spec: JobSpec, n: number, from?: Date): Date[]
describeTrigger(spec: JobSpec): string                      // "weekdays at 7:30", "every 30 minutes", "once on Oct 2, 09:00", "when a Claude Code session ends"
inActiveHours(spec: JobSpec, at: Date): boolean
```

- [ ] **Step 1: Failing tests.** `test/jobs-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseJob } from '../server/lib/agent/jobs/parse'
const md = (fm: string, body = 'Do the thing.') => `---\n${fm}\n---\n${body}\n`
const p = (fm: string, body?: string) => parseJob(md(fm, body), { defaultTimezone: 'America/New_York' })

describe('parseJob', () => {
  it('parses a full cron job', () => {
    const r = p('trigger: cron 30 7 * * 1-5\ntimezone: Europe/London\nactive_hours: 07:00-23:00\nthread: main\ncontext: light\ndeliver: [app]\nenabled: true')
    expect(r).toEqual({ ok: true, spec: expect.objectContaining({ trigger: { kind: 'cron', expr: '30 7 * * 1-5' }, timezone: 'Europe/London', activeHours: { start: '07:00', end: '23:00' }, enabled: true, deliver: ['app'], body: 'Do the thing.' }) })
  })
  it('applies defaults', () => {
    const r = p('trigger: every 30m')
    expect(r.ok && r.spec).toMatchObject({ timezone: 'America/New_York', model: 'default', thread: 'main', context: 'full', deliver: ['app'], enabled: false, activeHours: null, filter: null })
  })
  it.each([
    ['trigger: every 4m', /at least 5 minutes/],
    ['trigger: cron */2 * * * *', /at least 5 minutes/],
    ['trigger: cron not a cron', /invalid cron/],
    ['trigger: sometimes', /unknown trigger/],
    ['trigger: every 30m\ntimezone: Mars/Base', /timezone/],
    ['trigger: every 30m\nactive_hours: 7-23', /active_hours/],
    ['trigger: every 30m\nthread: elsewhere', /thread/],
    ['trigger: every 30m\nbogus: 1', /unknown key/],
    ['trigger: at not-a-date', /at/],
    ['trigger: event cc.nope', /unknown event/]
  ])('rejects %s', (fm, err) => {
    const r = p(fm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(err)
  })
  it('rejects an empty body and a missing frontmatter block', () => {
    expect(p('trigger: every 30m', '   ').ok).toBe(false)
    expect(parseJob('no frontmatter', { defaultTimezone: 'UTC' }).ok).toBe(false)
  })
  it('rejects an unknown model when a resolver is given', () => {
    const r = parseJob(md('trigger: every 30m\nmodel: nope'), { defaultTimezone: 'UTC', isKnownModel: id => id === 'qwen' })
    expect(r.ok).toBe(false)
  })
  it('accepts event triggers with a filter', () => {
    const r = p('trigger: event cc.session_end\nfilter: { project: mymind }')
    expect(r.ok && r.spec.filter).toEqual({ project: 'mymind' })
  })
})
```

`test/jobs-schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseJob } from '../server/lib/agent/jobs/parse'
import { nextRunAt, nextFireTimes, describeTrigger, inActiveHours } from '../server/lib/agent/jobs/schedule'
const spec = (fm: string) => { const r = parseJob(`---\n${fm}\n---\nx\n`, { defaultTimezone: 'America/New_York' }); if (!r.ok) throw new Error(r.error); return r.spec }

describe('schedule', () => {
  it('weekday cron in a timezone', () => {
    const s = spec('trigger: cron 30 7 * * 1-5')
    // Fri 2026-10-02 12:00Z → next is Mon 2026-10-05 07:30 EDT = 11:30Z
    expect(nextRunAt(s, new Date('2026-10-02T12:00:00Z'))?.toISOString()).toBe('2026-10-05T11:30:00.000Z')
    expect(describeTrigger(s)).toBe('weekdays at 7:30')
  })
  it('fires once across spring-forward (US, 2027-03-14)', () => {
    const s = spec('trigger: cron 30 7 * * *')
    const fires = nextFireTimes(s, 3, new Date('2027-03-13T12:00:00Z')).map(d => d.toISOString())
    expect(fires).toEqual(['2027-03-14T11:30:00.000Z', '2027-03-15T11:30:00.000Z', '2027-03-16T11:30:00.000Z'])
  })
  it('every interval and one-shot at', () => {
    expect(nextRunAt(spec('trigger: every 30m'), new Date('2026-10-02T12:00:00Z'))?.toISOString()).toBe('2026-10-02T12:30:00.000Z')
    expect(nextRunAt(spec('trigger: at 2026-10-02T09:00:00-04:00'), new Date('2026-10-01T00:00:00Z'))?.toISOString()).toBe('2026-10-02T13:00:00.000Z')
    expect(nextRunAt(spec('trigger: at 2026-10-02T09:00:00-04:00'), new Date('2026-10-03T00:00:00Z'))).toBeNull()
    expect(describeTrigger(spec('trigger: every 30m'))).toBe('every 30 minutes')
  })
  it('event jobs have no next run', () => {
    expect(nextRunAt(spec('trigger: event task.due'), new Date())).toBeNull()
    expect(describeTrigger(spec('trigger: event cc.session_end'))).toBe('when a Claude Code session ends')
  })
  it('active hours in the job timezone, including an overnight window', () => {
    const day = spec('trigger: every 30m\nactive_hours: 08:00-22:00')
    expect(inActiveHours(day, new Date('2026-10-02T13:00:00Z'))).toBe(true)   // 09:00 EDT
    expect(inActiveHours(day, new Date('2026-10-03T03:00:00Z'))).toBe(false)  // 23:00 EDT
    const night = spec('trigger: every 30m\nactive_hours: 22:00-06:00')
    expect(inActiveHours(night, new Date('2026-10-03T03:00:00Z'))).toBe(true)
  })
})
```

`test/frontmatter.test.ts`: round-trip `joinFrontmatter(splitFrontmatter(x).data, body)`; `setFrontmatterKey(md, 'enabled', false)` changes only that line (assert every other line identical); malformed YAML → `error` set.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - `frontmatter.ts` uses `yaml` (`parse`, `stringify`, and `parseDocument` for `setFrontmatterKey` so comments survive).
  - `parse.ts`:
    - **Accepted keys:** exactly `trigger, timezone, active_hours, model, thread, context, deliver, enabled, filter`. Anything else → `unknown key: <k>`.
    - **Trigger forms:**
      - `cron <expr>` is validated with `new Cron(expr, { timezone, paused: true })`. It must also pass `nextRuns(2)` spacing ≥ `MIN_INTERVAL_MS`, else `trigger must fire at least 5 minutes apart`.
      - `every <n>m|<n>h` must be ≥ 5m.
      - `at <ISO>` must satisfy `!isNaN(Date.parse)`.
      - `event <name>` must be one of `['cc.session_end', 'task.due']`, else `unknown event`.
    - **Timezone** is validated with `Intl.DateTimeFormat(undefined, { timeZone })` inside try/catch.
    - **`active_hours`** matches `/^\d{2}:\d{2}-\d{2}:\d{2}$/`.
    - **Body:** `body.trim()` must be non-empty and ≤ `JOB_BODY_MAX`.
  - `schedule.ts`:
    - `croner` handles `cron`, with `{ timezone }`.
    - `every` is computed as `from + n`.
    - `at` returns `Date.parse(expr)` when it is after `from`, else `null`.
    - `describeTrigger` has a small table for common cron shapes (`M H * * *` → "daily at H:MM", `M H * * 1-5` → "weekdays at H:MM", `M H * * D` → "<Day>s at H:MM"). Anything else falls back to `cron <expr>`.
    - `inActiveHours` compares HH:MM in the job timezone via `Intl.DateTimeFormat(…, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })`, and handles wrap when `end < start`.
- [ ] **Step 4: Run** → PASS; mutation-check the 5-minute rule, the DST test (swap croner for naive `+24h` math → red), the overnight window.
- [ ] **Step 5: Commit** `feat(jobs): frontmatter utils, job parser, croner scheduling`.

---

### Task 3: Skills move to `agent_skills` (same service API)

**Files:**
- Create: `server/lib/agent/config/revisions.ts`
- Modify: `server/services/skills.ts` (storage swap; public API unchanged: `Skill`, `SkillInput`, `listSkills`, `getSkill`, `createSkill`, `updateSkill`, `deleteSkill`, `validateSkill`, `SKILL_NAME_RE`, `SKILL_BODY_MAX`)
- Add to `server/services/skills.ts`: `getSkillSource(slug)`, `saveSkillSource(slug, content, expectedHash, actor)`, `listSkillRevisions(slug)`, `revertSkill(slug, revisionId, actor)`
- Create: `server/plugins/agent-skills-migrate.ts`
- Modify: `server/api/skills/*.ts` (publish `agentSkill`), `shared/types/live.ts` (`'agentSkill' | 'agentJob'`), `app/utils/live-dispatch.ts` (`agentSkill` → invalidate `['skills']` + `['agent','commands']`), `scripts/seed-skills.ts`
- Test: `test/skills.db.test.ts` (adapt), `test/skills-migrate.db.test.ts`, `test/agent-revisions.db.test.ts`

**Interfaces — Produces:**
```ts
// revisions.ts
recordRevision(i: { targetKind: 'skill' | 'job'; targetId: string; content: string; actor: 'human' | 'agent' | 'system'; runId?: string | null }): Promise<void>   // prunes to 100
listRevisions(targetKind: 'skill' | 'job', targetId: string, limit?: number): Promise<{ id: string; content: string; actor: string; createdAt: string }[]>
getRevision(id: string): Promise<{ id: string; targetKind: string; targetId: string; content: string } | null>
export const REVISIONS_KEPT = 100
// skills.ts additions
export interface SkillSource { slug: string; content: string; contentHash: string; active: boolean; source: 'human' | 'agent'; updatedAt: string }
getSkillSource(slug: string): Promise<SkillSource | null>
saveSkillSource(slug: string, content: string, expectedHash: string | null, actor: 'human' | 'agent'): Promise<SkillSource>  // throws ConflictError(current) on hash mismatch; validates
export class ConflictError extends Error { current: { content: string; contentHash: string } }
migrateSkillsFromDocuments(): Promise<number>   // idempotent
```

- [ ] **Step 1: Failing tests.**
  - `test/skills-migrate.db.test.ts`:
    - insert 2 fixture skill documents (`type='skill'`, path `/projects/mymind/skills/migtest-a.md`, frontmatter `{kind:'skill', name:'migtest-a', description:'d', whenToUse:'w', active:false, source:'agent'}`, content `'body A'`);
    - run `migrateSkillsFromDocuments()`, then assert:
      - `agent_skills` has `migtest-a` with `active=false` and `source='agent'`;
      - its content splits to that frontmatter plus body `'body A'`;
      - the fixture docs now have `deleted_at` set;
    - a second run inserts 0 new rows (idempotent).
    - Clean up the fixture docs and skills by slug prefix `migtest-`.
  - `test/agent-revisions.db.test.ts`: 105 `recordRevision` calls on one target leave 100 rows, newest kept.
  - `test/skills.db.test.ts`:
    - update the existing CRUD tests to the new storage (behaviour identical);
    - add: `saveSkillSource` with a stale hash throws `ConflictError` carrying the current content;
    - add: a successful save writes a revision with its actor;
    - add: `getSkill(name, { activeOnly: true })` returns the body for an active skill and null for an inactive one (Review Focus 4 — the slash-command tier path).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - **Skill markdown format:**
    ```
    ---
    name, description, when_to_use, active, source
    ---
    <body>
    ```
    `createSkill`/`updateSkill` serialize via `joinFrontmatter`. `listSkills`/`getSkill` read the derived columns plus the body from `splitFrontmatter(content).body`. `contentHash` = sha256 hex of `content`.
  - **Every write:**
    - validate with `validateSkill`;
    - update the derived columns;
    - `recordRevision(…)`;
    - `publishChange({ resource: 'agentSkill', … })`.
  - **`migrateSkillsFromDocuments`:**
    - select live `documents` where `type='skill'` whose slug (basename of the path, without `.md`) is not already in `agent_skills`;
    - build the markdown from `frontmatter` + `content`;
    - insert, then set `deleted_at = now()` on those documents in the same transaction;
    - record a `system` revision.
  - **Plugin:** on boot, `await migrateSkillsFromDocuments()` inside try/catch, and log the count.
  - Keep `notSkill()` in `documents.ts` (it now matches nothing new and stays harmless). Update its comment to say skills moved in cycle 74.
- [ ] **Step 4: Run** the three DB tests plus `test/skills-validate.test.ts` and `server/services/skills.test.ts` → PASS. Mutation-check idempotence (drop the not-exists filter → a duplicate-slug error or 2 rows) and revision pruning.
- [ ] **Step 5: Commit** `feat(skills): move skills to agent_skills with revisions; boot data move from documents`.

---

### Task 4: Jobs store, seeds and revert

**Files:**
- Create: `server/lib/agent/jobs/store.ts`, `server/lib/agent/jobs/seeds.ts`, `server/lib/agent/jobs/timezone.ts`
- Modify: `server/plugins/agent-runtime.ts` (install seeds + revalidate on boot)
- Test: `test/jobs-store.db.test.ts`

**Interfaces — Produces:**
```ts
export interface JobDTO {
  id: string; slug: string; content: string; contentHash: string; source: 'human' | 'agent'
  enabled: boolean; triggerKind: string | null; triggerExpr: string | null; timezone: string | null
  description: string | null; nextRunAt: string | null; parseError: string | null
  lastRunAt: string | null; lastRunId: string | null; lastOutcome: string | null; consecutiveFailures: number
  updatedAt: string
}
export const MAX_ENABLED_JOBS = 50
export class JobValidationError extends Error {}
export class ConflictError extends Error { current: { content: string; contentHash: string } }   // re-export skills' class
listJobs(): Promise<JobDTO[]>
getJob(slug: string): Promise<JobDTO | null>
createJob(i: { slug: string; content: string; actor: 'human' | 'agent' | 'system'; runId?: string | null }): Promise<JobDTO>
saveJob(slug: string, content: string, expectedHash: string | null, actor: 'human' | 'agent' | 'system', runId?: string | null): Promise<JobDTO>
setJobEnabled(slug: string, enabled: boolean, actor: 'human' | 'agent' | 'system'): Promise<JobDTO>   // rewrites the `enabled:` line via setFrontmatterKey
deleteJob(slug: string): Promise<boolean>
revertJob(slug: string, revisionId: string, actor: 'human' | 'agent'): Promise<JobDTO>
revalidateAll(): Promise<number>        // boot: re-parse every job; sets/clears parse_error; posts one main note per newly-invalid job
getDefaultTimezone(): Promise<string>   // settings 'agent_timezone' → else Intl resolved TZ
installSeedJobs(): Promise<number>      // morning-brief, evening-wrap, heartbeat, session-digest; disabled; skipped if slug exists
export const JOB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
```

- [ ] **Step 1: Failing test** `test/jobs-store.db.test.ts` (prefix every slug with `jstest-`; clean up by prefix):
  - create a valid job → `enabled`, `triggerKind`, `nextRunAt` are derived, and 1 revision exists;
  - invalid content throws `JobValidationError` and nothing is written;
  - `saveJob` with a stale hash throws `ConflictError` with the current content (Review Focus 5);
  - `setJobEnabled(false)` flips only the `enabled:` line (every other line of the content is unchanged) and clears `nextRunAt`;
  - saving new content recomputes `nextRunAt` from now;
  - the 51st enabled job is rejected with a message containing `50` (create 50 enabled jobs using `trigger: every 5h` in a loop, then a 51st);
  - `revertJob` restores an older revision's content and writes a new revision;
  - `installSeedJobs` is idempotent and installs its jobs disabled. Assert through `getJob('morning-brief')` without deleting real seeds, and only delete seeds this test created: record whether each existed before the call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - **`store.ts` is the only writer of `agent_jobs`.** On every write:
    1. `parseJob` with the default timezone and a model resolver (from the AI registry: `listModelDefs` or equivalent — find it with `grep -rn "export async function" server/lib/ai/registry/*.ts`);
    2. on error, throw `JobValidationError(error)`;
    3. compute the derived columns, with `nextRunAt = enabled ? nextRunAt(spec, new Date()) : null`;
    4. enforce `MAX_ENABLED_JOBS` (count enabled jobs excluding this slug);
    5. CAS on `contentHash` inside the UPDATE's `WHERE`; zero rows means `ConflictError`;
    6. `recordRevision`;
    7. `publishChange({ resource: 'agentJob', action, id })`.
  - **`revalidateAll`:** used at boot. It sets `parse_error` rather than throwing, and posts "Job <slug> is invalid: <error> — fix it on /jobs/<slug>." into main via `appendEvent(mainId, text, 'runtime:job-invalid')`. It posts only when `parse_error` changes from null to non-null.
  - **`seeds.ts`:** holds the four markdown files as template strings, with the frontmatter exactly as spec §8:
    - `session-digest`: `trigger: event cc.session_end`, `thread: main`, `context: light`, and a body asking for a 3–6 line digest ("what was done, what was deferred, anything that looks stuck; propose tasks rather than creating duplicates; NO_REPLY if the session was trivial").
    - `heartbeat`: `every 30m`, `active_hours: 08:00-22:00`, `context: light`. Its body is a checklist: overdue tasks, new captures, pending /review items, failed jobs, anything Tony asked to be reminded about; NO_REPLY if nothing merits attention.
- [ ] **Step 4: Run** → PASS; mutation-check the CAS, the guard and `setJobEnabled` line stability.
- [ ] **Step 5: Commit** `feat(jobs): job store with derived schedule, CAS, guards, revisions, seeds`.

---

### Task 5: Scheduler tick, events and outcomes

**Files:**
- Create: `server/lib/agent/jobs/tick.ts`, `server/lib/agent/jobs/events.ts`, `server/lib/agent/jobs/outcome.ts`
- Modify: `server/lib/agent/runtime/queue.ts` (call `jobsTick()` from `workerTick`; call `onRunFinished(run, outcome)` after `finishRun`), `server/lib/agent/runtime/wake.ts` (+ `jobId`, `context`), `server/lib/agent/runtime/runs.ts` `createRun` (+ `jobId`), `server/lib/agent/runtime/types.ts` (`RunInput.context?: 'light' | 'full'`), `server/api/hooks/cc/[event].post.ts` (fire `cc.session_end`)
- Test: `test/jobs-tick.db.test.ts`

**Interfaces — Produces:**
```ts
// tick.ts
jobsTick(opts?: { onlySlugs?: string[]; now?: Date; wakeFn?: typeof wake }): Promise<{ fired: string[]; skipped: string[] }>
runJobNow(slug: string, deps?: { wakeFn?: typeof wake }): Promise<{ runId: string } | { skipped: 'overlap' | 'disabled' | 'invalid' }>
// events.ts
fireEvent(name: 'cc.session_end' | 'task.due', key: string, payload: Record<string, unknown>, deps?: { onlySlugs?: string[]; wakeFn?: typeof wake }): Promise<string[]>
dueTaskEvents(opts?: { onlySlugs?: string[]; wakeFn?: typeof wake }): Promise<number>
eventBlock(name: string, payload: Record<string, unknown>): string
// outcome.ts
onRunFinished(run: AgentRun, outcome: RunOutcome): Promise<void>
export const MAX_CONSECUTIVE_FAILURES = 3
// wake.ts
export interface WakeRequest { reason: string; prompt: string; sessionKey?: SessionKey; model?: string | null; jobId?: string | null; context?: 'light' | 'full' }
```

- [ ] **Step 1: Failing tests** (`jstick-` slugs; `wakeFn` is a fake that records calls and returns `{ runId, conversationId }` for a real `createRun` into a scratch thread so `job_id` linkage and overlap use real rows):
  1. a due `every 30m` job fires once and `next_run_at` advances ~30 min;
  2. **two concurrent `jobsTick` calls fire it exactly once** (`Promise.all`);
  3. **missed runs:** `next_run_at` set 3 hours in the past on an `every 30m` job → exactly one fire, then `next_run_at` ≈ now + 30m (Review Focus 2);
  4. **overlap:** previous run still `running` → outcome `skipped`, schedule advances, `wakeFn` not called;
  5. outside `active_hours` → `skipped`, no wake;
  6. `at` job → fires, then `enabled: false` is written into its content with a `system` revision and `fired_at` set;
  7. `fireEvent('cc.session_end', 'sess-1', { project: 'mymind' })` fires a matching enabled event job once. The same key again fires nothing. A `filter: { project: other }` job doesn't fire;
  8. `dueTaskEvents`: a task with `due_date` in the past and `completed_at` null fires a `task.due` job once per (task, due date);
  9. `onRunFinished`:
     - `done` + `suppressed` → `silent`;
     - `done` → `spoke`;
     - `failed` ×3 → the job is auto-disabled (content `enabled: false`, `system` revision) and a `runtime:job-disabled` event row lands in main. Use a scratch thread as main via a test seam `mainConversationId` param — never the real main;
  10. **edit during a run** (Review Focus 3): while the run is `running`, `saveJob` changes the body. The tick does not fire it again (overlap). After finish, the next fire's `wakeFn` prompt contains the new body.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - **`jobsTick`:**
    1. in one transaction, `select id from agent_jobs where enabled and parse_error is null and next_run_at <= now() [and slug in onlySlugs] order by next_run_at for update skip locked limit 10`;
    2. for each job, compute the next `next_run_at` from **now** (this is what gives single catch-up), set `last_run_at = now()`, and for `at` jobs set `next_run_at = null` and `fired_at = now()`;
    3. commit, then act on each job outside the transaction:
       - outside active hours → `last_outcome = 'skipped'`;
       - last run still queued or running → `skipped`;
       - otherwise `wakeFn({ reason: 'job:' + slug, prompt: spec.body, sessionKey: spec.thread === 'main' ? 'main' : 'isolated:' + slug, model: spec.model === 'default' ? null : spec.model, jobId, context: spec.context })`, then set `last_run_id`;
    4. `at` jobs then call `setJobEnabled(slug, false, 'system')`.
  - **`fireEvent`:**
    1. load enabled event jobs whose `triggerExpr === name`;
    2. match `filter` (every key equals `String(payload[key])`);
    3. `insert into agent_job_fires … on conflict do nothing returning`; zero rows means already fired;
    4. wake with `prompt = body + '\n\n' + eventBlock(name, payload)`.
  - **`eventBlock`** renders plain sentences, e.g. "A Claude Code session just ended: '<title>' in project <slug>, <n> minutes. Summary: <summary or 'not summarised yet'>." No brackets.
  - **`dueTaskEvents`** runs `select id, title, due_date from tasks where due_date <= now() and completed_at is null and due_date > now() - interval '7 days'`. The key is `task:<id>:<due_date ISO>`.
  - **Pruning:** `jobsTick` also deletes `at` jobs with `fired_at < now() - interval '30 days'` (their revisions go with them via an explicit delete). Add test 11: a fired `at` job backdated 31 days is pruned, and one backdated 29 days is kept.
  - **Wiring:**
    - `workerTick` calls `await jobsTick()` and `await dueTaskEvents()` (each in try/catch) after recovery;
    - `enqueue`/`createRun` pass `jobId`;
    - `RunInput.context` carries through;
    - `execute()` calls `onRunFinished(run, outcome)` after `finishRun`, in try/catch.
  - **CC hook:** when `isEnd`, `void fireEvent('cc.session_end', session.id, { title, project, durationMinutes, summary })`. Read the project slug via the session's `projectId` and duration from `startedAt`/`endedAt`; resolve them cheaply in one query.
- [ ] **Step 4: Run** → PASS. Mutation-check:
  - remove `skip locked` → test 2 double-fires (or a lock-wait flake — use the fire count);
  - compute next from `next_run_at` instead of now → test 3 bursts;
  - drop the `on conflict` → test 7 fires twice.
- [ ] **Step 5: Commit** `feat(jobs): scheduler tick, event triggers (cc.session_end, task.due), run outcomes + auto-disable`.

---

### Task 6: Runtime changes — silent runs leave nothing, light context, queued visibility

**Files:**
- Modify: `server/lib/agent/runtime/runner.ts`, `server/lib/agent/runtime/queue.ts` (`EnqueueResult.queuedBehind`), `server/api/voice/ws.ts` (send `queued`), `app/lib/voice/messages.ts` (map `queued` like `steered`), `app/composables/useVoice.ts`
- Test: `test/agent-runner.db.test.ts` (extend), `test/agent-queue.db.test.ts` (extend), `app/lib/voice/messages.test.ts` (extend), `test/voice-ws-handler.test.ts` (extend)

**Interfaces — Produces:** `EnqueueResult.queuedBehind: boolean`; WS frame `{ type: 'queued', text }`; `MsgEffect.queued?: string`.

- [ ] **Step 1: Failing tests.**
  - **Runner:**
    - a wake run whose reply is `NO_REPLY` persists **zero** `conversation_messages` rows. This replaces the cycle-73 assertion that the event row is kept;
    - a speaking wake run persists `[event, assistant]`;
    - a wake run with `input.context = 'light'` over a 10-turn thread sends the model at most 4 turns. Assert via the fake `runAgent` capturing its `messages`: count the user-role messages ≤ 4 plus the current one;
    - a rescued (thrown) wake run with no reply persists nothing either.
  - **Queue:** a user `enqueue` into a thread whose running run is headless returns `{ steered: false, queuedBehind: true }`.
  - **ws handler:** that case sends `{type:'queued', text}`.
  - **messages.ts:** `{type:'queued', text:'hi', cid}` for the viewed thread → `{ queued: 'hi' }`; a mismatched cid is dropped.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - **Runner success path:** if `suppressed`, persist nothing: skip `appendMessages`, publish no `conversation` frame, and send `persisted` only if something was written. The outcome keeps `suppressed: true`.
  - **Runner rescue path:** for a wake run whose rescued assistant text is empty or suppressed, persist nothing (the event row is meaningless alone).
  - **Light context:** in the runner, after `groupTurns`, when `input.context === 'light'`, use `turns.slice(-4)` before costing (`LIGHT_CONTEXT_TURNS = 4` exported from `history.ts`).
  - **`queuedBehind`:** `enqueue` sets `queuedBehind = !!active && !steered`.
  - **ws:** `submit` sends `queued` for `queuedBehind` (and `state: idle` for voice, like `steered`).
  - **Client:** `useVoice` handles `fx.queued` with the same optimistic-bubble code path as `fx.steered` (extract a shared `appendOptimisticUser(text)`).
- [ ] **Step 4: Run** → PASS; mutation-check each.
- [ ] **Step 5: Commit** `feat(runtime): silent runs leave no rows, light context, queued-behind-wake visibility`.

---

### Task 7: Remove the legacy WS path and runtime flag

**Files:**
- Delete: `server/lib/voice/ws-legacy.ts`, `server/lib/agent/runtime/flag.ts`, `test/agent-runtime-flag-gate.test.ts`
- Modify: `server/api/voice/ws.ts`, `server/lib/agent/runtime/queue.ts`, `server/lib/agent/runtime/wake.ts`, `server/plugins/agent-runtime.ts`, `server/tasks/summarize-threads.ts`, `server/api/admin/agent/wake.post.ts`, `test/agent-wake-route.test.ts`, `test/voice-ws-handler.test.ts`, `docs/wiki/agent-runtime.md` (rollback section), `docs/DEPLOYMENT.md` if it mentions the flag

- [ ] **Step 1:** `grep -rn "runtimeEnabled\|RuntimeDisabledError\|loadRuntimeFlag\|legacyHooks\|ws-legacy\|AGENT_RUNTIME_KEY\|setRuntimeEnabledForTest" server app test docs` — this is the full list; remove every use: `ws.ts` hooks no longer branch; `enqueue`/`wake` no longer throw; the admin endpoint loses its 409 branch; the plugin always recovers and starts the worker; the summarize task always runs.
- [ ] **Step 2:** Update the tests that asserted flag behaviour (delete those cases; keep the rest). Update the wiki's rollback section: "Roll back by redeploying a cycle-73 build (`git revert` the cycle-74 merge); the `agent_runtime` setting no longer exists."
- [ ] **Step 3: Run** `pnpm test && pnpm test:db && pnpm typecheck && pnpm build` → all green; `grep` from Step 1 returns nothing outside `docs/handovers`.
- [ ] **Step 4: Commit** `refactor(runtime): delete the legacy WS path and the agent_runtime flag`.

---

### Task 8: Job tools and gate classes

**Files:**
- Create: `server/lib/agent/tools/jobs.ts`
- Modify: `server/lib/agent/tools.ts` (register), `server/lib/agent/runtime/gate.ts` (classes), `test/agent-gate.test.ts` (table), `server/lib/mcp/server.ts` only if tools are not auto-registered from `agentTools`
- Test: `test/agent-job-tools.db.test.ts`

**Interfaces — Produces:** `AgentTool`s `list_jobs`, `get_job`, `create_job`, `edit_job`, `delete_job`, `run_job`, `schedule_wake` — all `kind` set as below, none `dangerous`.

| tool | kind | schema | behaviour |
|---|---|---|---|
| `list_jobs` | read | `{}` | slug, enabled, trigger description, next run, last outcome |
| `get_job` | read | `{ slug }` | content + status + next 5 fire times |
| `create_job` | create | `{ slug, content }` | `createJob(actor 'agent')`; validation error returned as `{ ok:false, error }` |
| `edit_job` | create | `{ slug, old_string?, new_string?, replace_all?, content? }` | find/replace exactly like `edit_document` (unique match unless `replace_all`), or full `content`; saves with the current hash |
| `delete_job` | destructive | `{ slug }` | `deleteJob` |
| `run_job` | create | `{ slug }` | `runJobNow` |
| `schedule_wake` | create | `{ when, prompt, thread? }` | `when` = ISO datetime or relative `in 10m`/`in 2h`/`tomorrow 09:00` (resolved in the default timezone); creates slug `reminder-<6 hex>` with `trigger: at <ISO>`, `enabled: true`, `context: light` |

- [ ] **Step 1: Failing tests:**
  - `schedule_wake({ when: 'in 10m', prompt: 'stretch' })` creates an enabled `at` job about 10 minutes out;
  - `edit_job` find/replace changes one line and writes an `agent` revision;
  - an ambiguous `old_string` returns an error and writes nothing;
  - `create_job` with invalid content returns `{ ok:false }` and writes nothing;
  - gate table:
    - `list_jobs`/`get_job` → `run` (read);
    - `create_job`/`edit_job`/`run_job`/`schedule_wake` → `run` (add them to `APPEND_TOOLS`, the free-edit ruling D2);
    - `delete_job` → `run` too (D2). Add it to a new `FREE_TOOLS` set that `classifyForHeadless` checks before the destructive rule, and document why in a comment.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (relative-time parsing in a small pure helper with its own unit cases). **Step 4: Run** → PASS; mutation-check the gate entries and the find/replace uniqueness. **Step 5: Commit** `feat(jobs): agent job tools + schedule_wake; free in background runs (D2)`.

---

### Task 9: Jobs and skills HTTP API

**Files:**
- Create: `server/api/jobs/index.get.ts`, `server/api/jobs/index.post.ts`, `server/api/jobs/[slug].get.ts`, `server/api/jobs/[slug].put.ts`, `server/api/jobs/[slug].delete.ts`, `server/api/jobs/[slug]/run.post.ts`, `server/api/jobs/[slug]/enabled.put.ts`, `server/api/jobs/[slug]/revisions.get.ts`, `server/api/jobs/[slug]/revert.post.ts`
- Create: `server/api/skills/[name]/source.get.ts`, `server/api/skills/[name]/source.put.ts`, `server/api/skills/[name]/revisions.get.ts`, `server/api/skills/[name]/revert.post.ts`
- Test: `test/jobs-routes.test.ts` (handler tests with the store mocked, following `test/agent-runs-route.test.ts`)

**Contracts:**
- **`GET /api/jobs`:** `JobDTO[]`, each with `description` filled by `describeTrigger`.
- **`GET /api/jobs/:slug`:**
  ```
  { job: JobDTO,
    nextFireTimes: string[],   // 5
    runs: {                    // last 10 agent_runs where job_id
      id, status, suppressed, createdAt, durationMs,
      conversationId, assistantMessageId
    }[] }
  ```
- **`POST /api/jobs`:** body `{ slug, content }` → 201 `JobDTO`.
- **`PUT /api/jobs/:slug`:** body `{ content, expectedHash }` → the `JobDTO`, or:
  - **409** `{ current: { content, contentHash } }` on conflict (Review Focus 5);
  - **400** on validation (message = parse error).
- **`PUT /api/jobs/:slug/enabled`:** body `{ enabled }`.
- **`POST /api/jobs/:slug/run`:** `runJobNow`.
- **`GET /api/jobs/:slug/revisions`:** the revision list.
- **`POST /api/jobs/:slug/revert`:** body `{ revisionId }`.
- **Skills:** the same shape for source, revisions and revert.
- **Slugs:** `JOB_SLUG_RE` / `SKILL_NAME_RE`, else 400.
- **Actor:** every mutating route uses `human`.

- [ ] Steps: failing handler tests (success, 409 carries current content, 400 message, bad slug) → implement → pass + mutation → commit `feat(jobs): jobs + skill-source HTTP API with CAS`.

---

## Phase 2 — UI

### Task 10: Shared `MarkdownConfigEditor`, `/documents` refactored onto it

**Files:**
- Create: `app/components/MarkdownConfigEditor.vue`
- Modify: `app/components/documents/Editor.vue` (use it for the editor/preview area; keep load, autosave, breadcrumbs, share, save status)
- Test: `app/lib/documents/view-mode.test.ts` (unchanged, must pass), plus browser checks

**Interfaces — Produces:**
```vue
<MarkdownConfigEditor
  v-model="content"            // string
  :language="'markdown'"       // CodeLanguage
  :readonly="false"
  @save="…"                    // ⌘S
  @paste-image="(file) => …"   // optional; documents uses it for image upload
/>
```
It owns: the view-mode toggle (edit / split / preview, persisted via the existing `resolveViewMode` cookie), `DocumentsMarkdownToolbar` (markdown only, non-preview), `CodeEditor` and `MdView`. It exposes `applyTransform` / `insertText` via `defineExpose` for callers.

- [ ] Steps:
  1. Move the template section `app/components/documents/Editor.vue:351-480` (the mode toggle, toolbar, CodeEditor and MdView) and its supporting refs (`codeEditorRef`, `toolbarApplyTransform`, the paste/drop image handler hook-up, the view-mode computed) into the new component, **verbatim where possible**.
  2. `Editor.vue` renders `<MarkdownConfigEditor v-model="content" @update:model-value="onContentUpdate" @save="onSaveShortcut" @paste-image="…">`.
  3. `pnpm typecheck && pnpm build`.
  4. **Browser-validate `/documents`** (playwright-cli), since this is the most-used page and the biggest regression risk:
     - open a document;
     - type (autosave → "saved");
     - switch edit / split / preview;
     - use a toolbar bold;
     - paste an image;
     - switch documents mid-typing (the pending save still lands);
     - reload and see the content persisted.

     Screenshot each state.
  5. Commit `refactor(documents): extract MarkdownConfigEditor shared by documents, skills and jobs`.

---

### Task 11: Skills pages + navigation

**Files:**
- Create: `app/pages/skills/index.vue`, `app/pages/skills/[slug].vue`, `app/components/config/RevisionsPanel.vue` (shared with jobs), `app/composables/useConfigSource.ts` (load source + explicit save with `expectedHash`, dirty tracking, 409 handling)
- Modify: `app/layouts/default.vue` (add `{ label: 'Skills', icon: 'i-lucide-graduation-cap', to: '/skills' }` and `{ label: 'Jobs', icon: 'i-lucide-calendar-clock', to: '/jobs' }` after Memory; remove the Settings "Agent Skills" item), delete `app/pages/settings/skills.vue` and `app/components/settings/SkillsTab.vue` (move its enabled kill switch to `/skills` header), `app/utils/live-dispatch.ts` (`agentSkill` → `['skills']`, `['agent','commands']`)

**Interfaces — Produces:**
```ts
// useConfigSource.ts
useConfigSource(kind: 'skill' | 'job', slug: MaybeRefOrGetter<string>): {
  content: Ref<string>; dirty: ComputedRef<boolean>; saving: Ref<boolean>; error: Ref<string | null>
  conflict: Ref<{ content: string; contentHash: string } | null>
  save(): Promise<boolean>; discardToServer(): void; reload(): Promise<void>
}
// RevisionsPanel.vue props: { kind: 'skill' | 'job'; slug: string } ; emits reverted
```

- [ ] **Steps:**
  1. Build `useConfigSource`:
     - it tracks `savedHash`;
     - `save()` PUTs `{ content, expectedHash }`;
     - on 409 it sets `conflict` (the UI offers "Load theirs" and "Overwrite", where Overwrite re-saves with the new hash);
     - on 400 it sets `error` (shown inline above the editor);
     - a live `agentSkill` / `agentJob` change reloads when not dirty and shows a "changed elsewhere" badge when dirty.
  2. `/skills`: a card list (as the old SkillsTab, plus updated-at), an active switch (PUT `/api/skills/:name` `{active}`), a "New skill" button (modal with a slug, then navigate) and the kill-switch header.
  3. `/skills/[slug]`:
     - header with name, source badge and a Save button (disabled unless dirty), plus ⌘S;
     - `MarkdownConfigEditor`;
     - right column `RevisionsPanel`: a list of actor and time; clicking shows a read-only diff (use the existing diff util if any — `grep -rn "diff" app/lib app/components | head` — else a simple line diff) and a Revert button.
  4. Browser-validate: the nav shows Skills and Jobs and the Settings item is gone; edit a skill, then save, preview and revert; a stale save in a second tab gets the conflict UI; a `/<skill>` slash command in `/agent` still loads.
  5. Commit `feat(skills): /skills pages on the shared editor; Skills + Jobs in main nav`.

---

### Task 12: Jobs pages

**Files:**
- Create: `app/pages/jobs/index.vue`, `app/pages/jobs/[slug].vue`, `app/components/config/JobStatusPanel.vue`, `app/lib/jobs/templates.ts`
- Modify: `app/utils/live-dispatch.ts` (`agentJob` → `['jobs']`)

- [ ] **Steps:**
  1. **`/jobs`:** a `UTable` with these columns:
     - slug (link);
     - trigger description;
     - next run (relative with the absolute time in a tooltip);
     - last outcome as a badge (`spoke` success, `silent` neutral, `failed` error, `skipped` warning) with its time;
     - enabled switch (PUT `/enabled`);
     - invalid rows get a red `parse_error` badge.

     **New job** opens a modal with a slug and a template select: morning brief, heartbeat, event digest, blank (`app/lib/jobs/templates.ts` holds the markdown). It POSTs then navigates.
  2. **`/jobs/[slug]`:**
     - header with slug, source, enabled switch and Save;
     - `MarkdownConfigEditor`;
     - right column `JobStatusPanel`:
       - validation (green, or the exact error from the last 400 or `parse_error`);
       - next 5 fire times in the job timezone plus the `describeTrigger` text;
       - **Run now** (toast with the result, "skipped: overlap" shown plainly);
       - last 10 runs (status/outcome, duration, "view in thread" link to `/agent?c=<conversationId>` when it spoke, else "silent");
     - then `RevisionsPanel`.
  3. Browser-validate spec §10 scenarios 1 and 2:
     - create `every 5m` from the heartbeat template, enable it, Run now, then see the run row and either a message in main or silent;
     - break the frontmatter, Save, see the inline error and that nothing is persisted.
  4. Commit `feat(jobs): /jobs list and /jobs/[slug] editor with status, runs, revisions`.

---

### Task 13: Acceptance, docs, handover

**Files:**
- Create: `docs/wiki/agent-jobs.md`, `docs/handovers/2026-09-2X-bridget-jobs.md`
- Modify: `docs/wiki/agent-runtime.md` (silent runs, light context, queued frame, flag removal), `docs/wiki/agent-skills.md` (storage moved; routes), `docs/superpowers/plans/00-roadmap.md` (row 74)

- [ ] **Step 1:** All gates green; record counts.
- [ ] **Step 2:** Browser acceptance — spec §10 scenarios 1–6 with `playwright-cli`:
  - **Scenario 3:** say "remind me in 10 minutes to stretch", then check that the `reminder-*` job appears on `/jobs`. Wait for it, or temporarily edit its `at` time to 1 minute out, and confirm the reply lands in main and the job becomes disabled.
  - **Scenario 4:** enable `session-digest`, then POST a synthetic `SessionEnd` to `/api/hooks/cc/SessionEnd` with a test API token, then check that a digest lands in main. Disable it again afterwards.

  Assert on DOM/JSON, not model wording. Leave the seed jobs **disabled** at the end (Tony enables them).
- [ ] **Step 3:** Docs:
  - `agent-jobs.md` covers the file format, triggers, events, guards, tools, pages, failure handling and operational queries;
  - fix the runtime and skills wiki pages;
  - write the handover (frontmatter as in the cycle-73 handover, including migrations 0056, `migrations_run_on_prod: false`, and every planning ruling);
  - update the roadmap row.
- [ ] **Step 4:** Commit `docs(cycle-74): agent-jobs wiki, handover, roadmap`.
