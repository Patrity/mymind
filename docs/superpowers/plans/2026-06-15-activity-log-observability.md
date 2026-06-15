# Activity Log — Centralized Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single, queryable, live ledger of everything the system does — inbound requests, background jobs, model calls (per failover attempt), and agent tool calls — stored in Postgres, browsable + tailing at `/activity`, with badge + toast + Resend-email error alerts, all configurable in `/settings`.

**Architecture:** One `activity_log` table. A self-isolating capture primitive (`createRecorder` → `withSpan`/`recordEvent`) buffers rows and flushes to Postgres fire-and-forget; `AsyncLocalStorage` carries the active span so nested work auto-correlates by `trace_id`/`parent_id`. Five instrumentation seams emit into it (`withFailoverOver`, the 4 cron tasks, `enrichment.ts`, the agent tool wrapper, an inbound Nitro plugin). The `/activity` UI rides the existing cycle-21 live-data convention (`activity` becomes a `ResourceName`; vue-query + the `/api/events` SSE). A daily prune task enforces tiered retention. A server-side digester emails errors via Resend.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle + node-postgres, Zod, `@tanstack/vue-query`, Nuxt UI v4, Vitest (pure-unit, dependency-injection style — no Nuxt test env, no DB in tests).

**Spec:** [`../specs/2026-06-15-activity-log-observability-design.md`](../specs/2026-06-15-activity-log-observability-design.md)

---

## Conventions this plan follows (read once)

- **DB client:** `useDb()` (lazy pg pool singleton) from `server/db/index.ts`. New tables: create `server/db/schema/<name>.ts` **and** add `export * from './<name>'` to `server/db/schema/index.ts`.
- **Migrations:** `pnpm db:generate` diffs the schema barrel → writes `server/db/migrations/0014_*.sql` (commit it). `pnpm db:migrate` applies it. SQL files are committed. If `db:generate` can't reach a DB in your env, hand-write the migration file using the SQL shown in Task 1.
- **Tests:** live in `test/*.test.ts`, import server-lib by **relative path** (`../server/lib/...`), are **pure-unit** with `vi.fn()` / injected `deps`. **No test touches a real DB or Nitro.** Run a single test: `pnpm vitest run test/<file>.test.ts`. Full suite: `pnpm test`.
- **Vue refs in templates** from composables need `.value` (the composables return raw refs — see `config.saving.value` in existing tabs).
- **Component auto-import prefix:** `components/settings/ActivityAlertsTab.vue` → `<SettingsActivityAlertsTab />`.
- **Colors:** semantic aliases only (`error`/`warning`/`success`/`info`/`neutral`/`primary`).
- **Gates:** pure-logic tasks gate on `pnpm vitest run <file>`. UI/wiring tasks (no Nuxt test env exists) gate on `pnpm typecheck`. The final task runs the full gate (`typecheck` + `test` + `build` + `db:migrate`).
- **Two deliberate simplifications vs the spec** (apply throughout): (1) `withSpan` records **one row at completion** (status `ok`/`error` + duration), not a separate `running` row then an update — a buffered fire-and-forget logger should never do update-by-id churn; a live "in-flight" row is a future seam. (2) The error **toast** is driven by the `/api/activity/count` payload (which carries the newest unacked error's id+name), watched in the layout — staying within the thin-signal convention (no payload on the SSE wire) while avoiding a per-row fetch.

---

## File map

**New — server core (`server/lib/observability/`)**
- `types.ts` — `Kind`, `Severity`, `Status`, `ObservabilityConfig`, `DEFAULT_CONFIG`, row-input types.
- `redact.ts` — `truncate()`, `sanitizeRequest()/sanitizeResponse()` (no keys, no vectors, size caps).
- `config.ts` — Zod schema, `parseObsConfig`, `redactObsConfig`, `loadObsConfig`/`saveObsConfig`/`invalidateObsConfig` (reuses `ai/registry/crypto.ts`).
- `record.ts` — `createRecorder(deps)` (`withSpan`/`recordEvent`/`flush`, ALS), plus the wired `recorder` singleton + `withSpan`/`recordEvent` re-exports.
- `notify.ts` — `shouldNotify()`, `buildDigest()` (pure) + `createEmailDigester()`.
- `email.ts` — `sendResendEmail()` (Resend REST via `$fetch`).

**New — schema / tasks / plugin**
- `server/db/schema/activity-log.ts` — the table.
- `server/db/migrations/0014_*.sql` — generated.
- `server/tasks/prune-activity-log.ts` — retention prune.
- `server/plugins/observe-requests.ts` — inbound capture (Nitro `request`/`afterResponse` hooks).
- `server/services/activity.ts` — `buildActivityWhere()` (pure) + `listActivity`/`getActivityTrace`/`countErrors`/`ackActivity`/`ackAll`/`pruneActivity`.

**New — API**
- `server/api/activity/index.get.ts`, `[id].get.ts`, `[id]/ack.post.ts`, `ack-all.post.ts`, `count.get.ts`
- `server/api/settings/observability-config.get.ts`, `observability-config.put.ts`

**New — shared / client**
- `shared/types/activity.ts` — `ActivityDTO`, `ActivityListParams`, list/count response types.
- `app/composables/useActivityLog.ts`, `app/composables/useObservabilityConfig.ts`
- `app/pages/activity/index.vue`, `app/pages/activity/[id].vue`
- `app/components/settings/ActivityAlertsTab.vue`

**Modified**
- `server/db/schema/index.ts` (+1 export)
- `shared/types/live.ts` (+`'activity'` in `ResourceName`)
- `app/utils/live-dispatch.ts` (+`activity` override)
- `server/lib/ai/registry/resolve.ts` (instrument `withFailoverOver`)
- `server/tasks/{embed-documents,enrich-input,enrich-images,enrich-memories}.ts` (wrap in `withSpan('job', …)`)
- `server/services/enrichment.ts` (console → structured records)
- `server/lib/agent/ai-tools.ts` (wrap tool handler in `withSpan('tool', …)`)
- `app/pages/settings.vue` (+ tab)
- `app/layouts/default.vue` (+ nav item, badge, toast watcher)
- `nuxt.config.ts` (+ prune scheduledTask)

**New tests** — `test/obs-redact.test.ts`, `obs-config.test.ts`, `obs-record.test.ts`, `obs-notify.test.ts`, `obs-failover.test.ts`, `obs-activity-where.test.ts`, `obs-prune.test.ts`, and additions to `test/live-dispatch.test.ts`.

---

## Task 1: `activity_log` table + migration

**Files:**
- Create: `server/db/schema/activity-log.ts`
- Modify: `server/db/schema/index.ts`
- Create: `server/db/migrations/0014_activity_log.sql` (via `pnpm db:generate`, or hand-written from the SQL below)

- [ ] **Step 1: Write the schema file**

`server/db/schema/activity-log.ts`:
```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'

// Unified observability ledger: one row per captured span (inbound request,
// cron job, model call, failover attempt, agent tool call). Correlated by
// trace_id (the root operation) + parent_id (self-ref nesting). See
// docs/superpowers/specs/2026-06-15-activity-log-observability-design.md
export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  traceId: uuid('trace_id').notNull(),
  parentId: uuid('parent_id'),
  kind: text('kind').notNull(),          // inbound | job | model | attempt | tool
  name: text('name').notNull(),
  status: text('status').notNull(),      // ok | error | warn
  severity: text('severity').notNull(),  // debug | info | warn | error
  usage: text('usage'),
  provider: text('provider'),
  modelId: text('model_id'),
  attempt: integer('attempt'),
  durationMs: integer('duration_ms'),
  tokens: jsonb('tokens'),
  request: jsonb('request'),
  response: jsonb('response'),
  error: jsonb('error'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true })
}, (t) => [
  index('activity_created_idx').on(t.createdAt.desc()),
  index('activity_trace_idx').on(t.traceId),
  index('activity_kind_idx').on(t.kind),
  index('activity_severity_idx').on(t.severity)
])

export type ActivityRow = typeof activityLog.$inferSelect
export type ActivityInsert = typeof activityLog.$inferInsert
```

- [ ] **Step 2: Register the table in the barrel**

Add to `server/db/schema/index.ts` (append a line):
```ts
export * from './activity-log'
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `server/db/migrations/0014_*.sql` is created plus updated `meta/` snapshots. It should contain a `CREATE TABLE "activity_log"` and the four `CREATE INDEX` statements.

If `db:generate` cannot reach a database in your environment, hand-write `server/db/migrations/0014_activity_log.sql` with exactly this (and add the matching journal entry the same way prior migrations did — copy the pattern from `0013`'s `meta/_journal.json` entry):
```sql
CREATE TABLE IF NOT EXISTS "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"usage" text,
	"provider" text,
	"model_id" text,
	"attempt" integer,
	"duration_ms" integer,
	"tokens" jsonb,
	"request" jsonb,
	"response" jsonb,
	"error" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_created_idx" ON "activity_log" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_trace_idx" ON "activity_log" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_kind_idx" ON "activity_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_severity_idx" ON "activity_log" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_unacked_error_idx" ON "activity_log" USING btree ("acked_at") WHERE "status" = 'error' AND "acked_at" IS NULL;
```
(The partial `activity_unacked_error_idx` powers the badge count; Drizzle's fluent API can't always express partial indexes, so it's added in SQL here regardless of generate-vs-hand-write.)

- [ ] **Step 4: Apply + verify**

Run: `pnpm db:migrate` then `pnpm typecheck`
Expected: migrate applies cleanly; typecheck exits 0.

- [ ] **Step 5: Commit**
```bash
git add server/db/schema/activity-log.ts server/db/schema/index.ts server/db/migrations
git commit -m "feat(observability): add activity_log table + migration"
```

---

## Task 2: Shared types + config defaults

**Files:**
- Create: `shared/types/activity.ts`
- Create: `server/lib/observability/types.ts`

- [ ] **Step 1: Write the shared (client+server) DTO types**

`shared/types/activity.ts`:
```ts
// Shared client/server types for the activity log.
export const ACTIVITY_KINDS = ['inbound', 'job', 'model', 'attempt', 'tool'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export type ActivitySeverity = 'debug' | 'info' | 'warn' | 'error'
export type ActivityStatus = 'ok' | 'error' | 'warn'

export interface ActivityDTO {
  id: string
  traceId: string
  parentId: string | null
  kind: ActivityKind
  name: string
  status: ActivityStatus
  severity: ActivitySeverity
  usage: string | null
  provider: string | null
  modelId: string | null
  attempt: number | null
  durationMs: number | null
  tokens: { prompt?: number, completion?: number, total?: number } | null
  request: unknown
  response: unknown
  error: { message: string, stack?: string, cause?: string } | null
  meta: Record<string, unknown>
  ackedAt: string | null
  createdAt: string
  finishedAt: string | null
}

export interface ActivityListParams {
  kind?: ActivityKind
  status?: ActivityStatus
  severity?: ActivitySeverity
  usage?: string
  traceId?: string
  q?: string
  limit?: number
  before?: string // ISO cursor (createdAt) for pagination
}

export interface ActivityCount {
  unacked: number
  latest: { id: string, name: string, severity: ActivitySeverity, at: string } | null
}
```

- [ ] **Step 2: Write the server config + row-input types**

`server/lib/observability/types.ts`:
```ts
import type { ActivityKind, ActivitySeverity, ActivityStatus } from '../../../shared/types/activity'

export type { ActivityKind, ActivitySeverity, ActivityStatus }

// What a caller hands to recordEvent/withSpan (the recorder fills id/trace/parent/timestamps).
export interface SpanInput {
  kind: ActivityKind
  name: string
  status?: ActivityStatus      // default 'ok'
  severity?: ActivitySeverity  // default 'info'
  usage?: string | null
  provider?: string | null
  modelId?: string | null
  attempt?: number | null
  durationMs?: number | null
  tokens?: Record<string, number> | null
  request?: unknown
  response?: unknown
  error?: { message: string, stack?: string, cause?: string } | null
  meta?: Record<string, unknown>
}

export interface ObservabilityConfig {
  version: 1
  retainInfoDays: number
  retainErrorDays: number
  maxRows: number
  capture: Record<ActivityKind, boolean>
  alerts: {
    badge: boolean
    toast: boolean
    email: {
      enabled: boolean
      recipient: string | null
      from: string | null
      apiKeyEnc: string | null // Resend key, AES-GCM via ai/registry/crypto.ts; server-only
      minSeverity: 'warn' | 'error'
      digestWindowMin: number
    }
  }
}

export const DEFAULT_CONFIG: ObservabilityConfig = {
  version: 1,
  retainInfoDays: 14,
  retainErrorDays: 90,
  maxRows: 500_000,
  capture: { inbound: true, job: true, model: true, attempt: true, tool: true },
  alerts: {
    badge: true,
    toast: true,
    email: {
      enabled: false,
      recipient: null,
      from: null,
      apiKeyEnc: null,
      minSeverity: 'error',
      digestWindowMin: 15
    }
  }
}
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
```bash
git add shared/types/activity.ts server/lib/observability/types.ts
git commit -m "feat(observability): shared activity DTOs + server config types"
```

---

## Task 3: Redaction helpers (TDD)

**Files:**
- Create: `server/lib/observability/redact.ts`
- Test: `test/obs-redact.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-redact.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { truncate, sanitizeRequest, sanitizeResponse } from '../server/lib/observability/redact'

describe('truncate', () => {
  it('passes through short strings unchanged', () => {
    expect(truncate('hello', 100)).toBe('hello')
  })
  it('caps long strings and appends a marker', () => {
    const out = truncate('x'.repeat(50), 10)
    expect(out.startsWith('xxxxxxxxxx')).toBe(true)
    expect(out).toContain('…truncated')
    expect(out.length).toBeLessThan(50)
  })
})

describe('sanitizeRequest', () => {
  it('keeps chat messages but truncates oversize content', () => {
    const req = sanitizeRequest('model', { messages: [{ role: 'user', content: 'y'.repeat(20_000) }] }) as { messages: { content: string }[] }
    expect(req.messages[0]!.content).toContain('…truncated')
  })
  it('reduces an embeddings request to text + count, never the vectors', () => {
    const req = sanitizeRequest('attempt', { inputs: ['a', 'b', 'c'] }) as Record<string, unknown>
    expect(req.count).toBe(3)
    expect(JSON.stringify(req)).not.toContain('vector')
  })
  it('never includes an apiKey/authorization even if present', () => {
    const req = sanitizeRequest('model', { messages: [], apiKey: 'secret', authorization: 'Bearer secret' })
    expect(JSON.stringify(req)).not.toContain('secret')
  })
})

describe('sanitizeResponse', () => {
  it('drops embedding vectors, keeping dim + count', () => {
    const res = sanitizeResponse({ data: [[0.1, 0.2, 0.3]], usage: { total: 1 } }) as Record<string, unknown>
    expect(res.dim).toBe(3)
    expect(res.count).toBe(1)
    expect(JSON.stringify(res)).not.toContain('0.1')
  })
  it('truncates long assistant text', () => {
    const res = sanitizeResponse('z'.repeat(50_000)) as string
    expect(res).toContain('…truncated')
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-redact.test.ts`
Expected: FAIL — `Cannot find module '../server/lib/observability/redact'`.

- [ ] **Step 3: Implement**

`server/lib/observability/redact.ts`:
```ts
import type { ActivityKind } from './types'

const MAX_PART = 8_000   // per string/message content
const MAX_TOTAL = 32_000 // per request/response blob (JSON length)
const SECRET_KEYS = new Set(['apikey', 'api_key', 'authorization', 'auth', 'password', 'token', 'secret'])

export function truncate(s: string, max = MAX_PART): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `…truncated(${s.length - max} more chars)`
}

// Looks like an embedding vector array? (number[] or number[][])
function isVectorish(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false
  const first = v[0]
  if (typeof first === 'number') return v.length > 16
  if (Array.isArray(first)) return typeof first[0] === 'number'
  return false
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return truncate(value)
  if (isVectorish(value)) {
    const arr = value as unknown[]
    const dim = Array.isArray(arr[0]) ? (arr[0] as unknown[]).length : arr.length
    return { _vector: true, dim, count: Array.isArray(arr[0]) ? arr.length : 1 }
  }
  if (Array.isArray(value)) return depth > 4 ? '[…]' : value.map(v => scrub(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue // never log secrets
      out[k] = depth > 4 ? '[…]' : scrub(v, depth + 1)
    }
    return out
  }
  return value
}

function cap(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json !== undefined && json.length > MAX_TOTAL) {
    return { _truncated: true, preview: truncate(json, MAX_TOTAL) }
  }
  return value
}

/** Sanitize a captured request payload by kind. Embedding inputs collapse to text+count. */
export function sanitizeRequest(kind: ActivityKind, req: unknown): unknown {
  if (req && typeof req === 'object' && 'inputs' in (req as Record<string, unknown>)) {
    const inputs = (req as { inputs: unknown }).inputs
    if (Array.isArray(inputs)) {
      return { count: inputs.length, sample: truncate(String(inputs[0] ?? ''), 500) }
    }
  }
  return cap(scrub(req))
}

/** Sanitize a captured response. Embedding vectors collapse to {dim,count}. */
export function sanitizeResponse(res: unknown): unknown {
  const r = res as Record<string, unknown> | undefined
  const data = r?.data ?? r?.embeddings
  if (Array.isArray(data) && isVectorish(data)) {
    const dim = Array.isArray(data[0]) ? (data[0] as unknown[]).length : data.length
    return { dim, count: Array.isArray(data[0]) ? data.length : 1, usage: r?.usage ?? null }
  }
  return cap(scrub(res))
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run test/obs-redact.test.ts`
Expected: PASS (all 7 assertions).

- [ ] **Step 5: Commit**
```bash
git add server/lib/observability/redact.ts test/obs-redact.test.ts
git commit -m "feat(observability): per-kind redaction (no keys, no vectors, size caps)"
```

---

## Task 4: Observability config store (TDD)

**Files:**
- Create: `server/lib/observability/config.ts`
- Test: `test/obs-config.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-config.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { parseObsConfig, redactObsConfig } from '../server/lib/observability/config'
import { DEFAULT_CONFIG } from '../server/lib/observability/types'

beforeAll(() => { process.env.BETTER_AUTH_SECRET ||= 'test-secret-test-secret-test-secret' })

describe('parseObsConfig', () => {
  it('accepts the default config', () => {
    expect(parseObsConfig(DEFAULT_CONFIG).maxRows).toBe(500_000)
  })
  it('fills defaults for a partial doc', () => {
    const c = parseObsConfig({ version: 1 })
    expect(c.retainInfoDays).toBe(14)
    expect(c.alerts.email.enabled).toBe(false)
    expect(c.capture.model).toBe(true)
  })
  it('rejects a bad shape', () => {
    expect(() => parseObsConfig({ version: 1, retainInfoDays: 'soon' })).toThrow()
  })
})

describe('redactObsConfig', () => {
  it('strips the email apiKeyEnc, exposing only hasEmailKey', () => {
    const doc = parseObsConfig({ ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, email: { ...DEFAULT_CONFIG.alerts.email, apiKeyEnc: 'CIPHERTEXT' } } })
    const red = redactObsConfig(doc) as { alerts: { email: Record<string, unknown> } }
    expect(JSON.stringify(red)).not.toContain('CIPHERTEXT')
    expect(red.alerts.email.hasKey).toBe(true)
    expect('apiKeyEnc' in red.alerts.email).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/lib/observability/config.ts`:
```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { DEFAULT_CONFIG, type ObservabilityConfig } from './types'
import { ACTIVITY_KINDS } from '../../../shared/types/activity'

const KEY = 'observability_config'

const captureSchema = z.object(
  Object.fromEntries(ACTIVITY_KINDS.map(k => [k, z.boolean().default(true)]))
).default(DEFAULT_CONFIG.capture)

const schema = z.object({
  version: z.literal(1),
  retainInfoDays: z.number().int().positive().default(DEFAULT_CONFIG.retainInfoDays),
  retainErrorDays: z.number().int().positive().default(DEFAULT_CONFIG.retainErrorDays),
  maxRows: z.number().int().positive().default(DEFAULT_CONFIG.maxRows),
  capture: captureSchema,
  alerts: z.object({
    badge: z.boolean().default(true),
    toast: z.boolean().default(true),
    email: z.object({
      enabled: z.boolean().default(false),
      recipient: z.string().email().nullable().default(null),
      from: z.string().email().nullable().default(null),
      apiKeyEnc: z.string().nullable().default(null),
      minSeverity: z.enum(['warn', 'error']).default('error'),
      digestWindowMin: z.number().int().positive().default(15)
    }).default(DEFAULT_CONFIG.alerts.email)
  }).default(DEFAULT_CONFIG.alerts)
})

export function parseObsConfig(input: unknown): ObservabilityConfig {
  return schema.parse(input) as ObservabilityConfig
}

export interface RedactedObsConfig extends Omit<ObservabilityConfig, 'alerts'> {
  alerts: Omit<ObservabilityConfig['alerts'], 'email'> & {
    email: Omit<ObservabilityConfig['alerts']['email'], 'apiKeyEnc'> & { hasKey: boolean }
  }
}

export function redactObsConfig(doc: ObservabilityConfig): RedactedObsConfig {
  const { apiKeyEnc, ...email } = doc.alerts.email
  return { ...doc, alerts: { ...doc.alerts, email: { ...email, hasKey: apiKeyEnc !== null } } }
}

let cache: ObservabilityConfig | null = null

export async function loadObsConfig(): Promise<ObservabilityConfig> {
  if (cache) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = row ? parseObsConfig(row.value) : DEFAULT_CONFIG
  return cache
}

export async function saveObsConfig(doc: ObservabilityConfig): Promise<void> {
  const validated = parseObsConfig(doc)
  const db = useDb()
  await db.insert(settings)
    .values({ key: KEY, value: validated, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: validated, updatedAt: new Date() } })
  cache = validated
}

export function invalidateObsConfig(): void { cache = null }
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run test/obs-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/observability/config.ts test/obs-config.test.ts
git commit -m "feat(observability): config store (zod + defaults + key redaction)"
```

---

## Task 5: The capture recorder (TDD)

**Files:**
- Create: `server/lib/observability/record.ts`
- Test: `test/obs-record.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-record.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createRecorder } from '../server/lib/observability/record'
import type { ActivityInsert } from '../server/db/schema/activity-log'

function harness() {
  const rows: ActivityInsert[] = []
  let n = 0
  const rec = createRecorder({
    sink: async (batch) => { rows.push(...batch) },
    publish: vi.fn(),
    notify: vi.fn(),
    now: () => 1000,
    newId: () => `id-${++n}`
  })
  return { rec, rows }
}

describe('withSpan', () => {
  it('records one ok row at completion and returns fn result', async () => {
    const { rec, rows } = harness()
    const out = await rec.withSpan({ kind: 'job', name: 'enrich-input' }, async () => 42)
    await rec.flush()
    expect(out).toBe(42)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('job')
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.parentId).toBeNull()
  })

  it('nests children under the active span via trace_id/parent_id', async () => {
    const { rec, rows } = harness()
    await rec.withSpan({ kind: 'job', name: 'parent' }, async () => {
      await rec.withSpan({ kind: 'model', name: 'chat:reasoning' }, async () => 'ok')
    })
    await rec.flush()
    const job = rows.find(r => r.kind === 'job')!
    const model = rows.find(r => r.kind === 'model')!
    expect(model.traceId).toBe(job.traceId)
    expect(model.parentId).toBe(job.id)
  })

  it('records an error row and re-throws (never swallows)', async () => {
    const { rec, rows } = harness()
    await expect(rec.withSpan({ kind: 'model', name: 'x' }, async () => { throw new Error('boom') }))
      .rejects.toThrow('boom')
    await rec.flush()
    expect(rows[0]!.status).toBe('error')
    expect((rows[0]!.error as { message: string }).message).toBe('boom')
    expect(rows[0]!.severity).toBe('error')
  })
})

describe('recordEvent', () => {
  it('is non-interfering: a throwing sink never propagates', async () => {
    const rows: ActivityInsert[] = []
    const rec = createRecorder({ sink: async () => { throw new Error('db down') }, now: () => 1, newId: () => 'x' })
    rec.recordEvent({ kind: 'attempt', name: 'a', status: 'error', severity: 'error' })
    await expect(rec.flush()).resolves.toBeUndefined() // swallowed, not thrown
    expect(rows).toHaveLength(0)
  })

  it('calls publish once per flush and notify with error rows only', async () => {
    const publish = vi.fn(); const notify = vi.fn()
    const rec = createRecorder({ sink: async () => {}, publish, notify, now: () => 1, newId: () => 'x' })
    rec.recordEvent({ kind: 'job', name: 'ok', severity: 'info' })
    rec.recordEvent({ kind: 'attempt', name: 'bad', status: 'error', severity: 'error' })
    await rec.flush()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toHaveLength(1) // only the error row
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/lib/observability/record.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ActivityInsert } from '../../db/schema/activity-log'
import type { SpanInput } from './types'

interface SpanCtx { traceId: string, spanId: string }

export interface RecorderDeps {
  sink: (rows: ActivityInsert[]) => Promise<void>
  publish?: () => void
  notify?: (errorRows: ActivityInsert[]) => void
  now?: () => number
  newId?: () => string
}

export interface Recorder {
  recordEvent: (input: SpanInput) => void
  withSpan: <T>(input: SpanInput, fn: () => Promise<T>) => Promise<T>
  flush: () => Promise<void>
  /** Run fn as the root of a new trace (used by inbound capture). */
  runInTrace: <T>(fn: () => Promise<T>) => Promise<T>
}

export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const als = new AsyncLocalStorage<SpanCtx>()
  let buffer: ActivityInsert[] = []

  function build(input: SpanInput, ctx: SpanCtx, parent: SpanCtx | undefined): ActivityInsert {
    const at = new Date(now())
    return {
      id: ctx.spanId,
      traceId: ctx.traceId,
      parentId: parent?.spanId ?? null,
      kind: input.kind,
      name: input.name,
      status: input.status ?? 'ok',
      severity: input.severity ?? 'info',
      usage: input.usage ?? null,
      provider: input.provider ?? null,
      modelId: input.modelId ?? null,
      attempt: input.attempt ?? null,
      durationMs: input.durationMs ?? null,
      tokens: input.tokens ?? null,
      request: input.request ?? null,
      response: input.response ?? null,
      error: input.error ?? null,
      meta: input.meta ?? {},
      ackedAt: null,
      createdAt: at,
      finishedAt: at
    }
  }

  function enqueue(input: SpanInput, ctx?: SpanCtx) {
    try {
      const parent = als.getStore()
      const c = ctx ?? { traceId: parent?.traceId ?? newId(), spanId: newId() }
      buffer.push(build(input, c, parent && parent.spanId !== c.spanId ? parent : (ctx ? parent : undefined)))
    } catch (err) {
      console.error('[observability] enqueue failed', err)
    }
  }

  function recordEvent(input: SpanInput) {
    enqueue(input)
  }

  async function withSpan<T>(input: SpanInput, fn: () => Promise<T>): Promise<T> {
    const parent = als.getStore()
    const ctx: SpanCtx = { traceId: parent?.traceId ?? newId(), spanId: newId() }
    const started = now()
    try {
      const result = await als.run(ctx, fn)
      enqueue({ ...input, status: input.status ?? 'ok', durationMs: now() - started, response: input.response }, ctx)
      return result
    } catch (err) {
      enqueue({
        ...input,
        status: 'error',
        severity: 'error',
        durationMs: now() - started,
        error: { message: (err as Error).message, stack: (err as Error).stack }
      }, ctx)
      throw err
    }
  }

  async function runInTrace<T>(fn: () => Promise<T>): Promise<T> {
    return als.run({ traceId: newId(), spanId: newId() }, fn)
  }

  async function flush(): Promise<void> {
    if (!buffer.length) return
    const rows = buffer
    buffer = []
    try {
      await deps.sink(rows)
    } catch (err) {
      console.error('[observability] flush failed (dropping batch)', err)
      return // never rethrow into the app
    }
    deps.publish?.()
    const errs = rows.filter(r => r.status === 'error' || r.severity === 'error' || r.severity === 'warn')
    if (errs.length) deps.notify?.(errs)
  }

  return { recordEvent, withSpan, flush, runInTrace }
}
```

> Note on the `enqueue` parent logic: when `withSpan` passes an explicit `ctx`, the child's parent is the surrounding store; for `recordEvent` (no explicit ctx) the row is parented to the active span if one exists, else it's its own root. The test `nests children…` exercises the `withSpan`-inside-`withSpan` path.

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run test/obs-record.test.ts`
Expected: PASS (all cases). If the `nests children` test fails on `parentId`, confirm `als.run(ctx, fn)` wraps `fn` so the inner `withSpan` sees `ctx` as its store.

- [ ] **Step 5: Commit**
```bash
git add server/lib/observability/record.ts test/obs-record.test.ts
git commit -m "feat(observability): self-isolating recorder (ALS nesting, fire-and-forget flush)"
```

---

## Task 6: Email digester + Resend sender (TDD for the pure parts)

**Files:**
- Create: `server/lib/observability/notify.ts`
- Create: `server/lib/observability/email.ts`
- Test: `test/obs-notify.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-notify.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { shouldNotify, buildDigest } from '../server/lib/observability/notify'
import { DEFAULT_CONFIG } from '../server/lib/observability/types'
import type { ActivityInsert } from '../server/db/schema/activity-log'

const cfg = (over: Partial<typeof DEFAULT_CONFIG.alerts.email>) => ({
  ...DEFAULT_CONFIG,
  alerts: { ...DEFAULT_CONFIG.alerts, email: { ...DEFAULT_CONFIG.alerts.email, enabled: true, recipient: 'me@x.io', apiKeyEnc: 'k', ...over } }
})

describe('shouldNotify', () => {
  it('false when email disabled', () => {
    expect(shouldNotify(DEFAULT_CONFIG, 'error')).toBe(false)
  })
  it('true for error when enabled with a recipient + key', () => {
    expect(shouldNotify(cfg({}), 'error')).toBe(true)
  })
  it('respects minSeverity (warn excluded when threshold is error)', () => {
    expect(shouldNotify(cfg({ minSeverity: 'error' }), 'warn')).toBe(false)
    expect(shouldNotify(cfg({ minSeverity: 'warn' }), 'warn')).toBe(true)
  })
  it('false when enabled but no recipient/key', () => {
    expect(shouldNotify(cfg({ recipient: null }), 'error')).toBe(false)
    expect(shouldNotify(cfg({ apiKeyEnc: null }), 'error')).toBe(false)
  })
})

describe('buildDigest', () => {
  it('coalesces N errors into one subject + body', () => {
    const rows = [
      { name: 'enrich-input', kind: 'job', error: { message: 'parse failed' } },
      { name: 'chat:reasoning', kind: 'model', error: { message: 'no usable content' } }
    ] as unknown as ActivityInsert[]
    const d = buildDigest(rows)
    expect(d.subject).toContain('2')
    expect(d.text).toContain('enrich-input')
    expect(d.text).toContain('no usable content')
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Resend sender**

`server/lib/observability/email.ts`:
```ts
// Minimal Resend REST client — no SDK dependency. https://resend.com/docs/api-reference/emails/send-email
export async function sendResendEmail(opts: { apiKey: string, from: string, to: string, subject: string, text: string }): Promise<void> {
  await $fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: { from: opts.from, to: [opts.to], subject: opts.subject, text: opts.text },
    signal: AbortSignal.timeout(15_000)
  })
}
```

- [ ] **Step 4: Implement the notifier**

`server/lib/observability/notify.ts`:
```ts
import type { ActivityInsert } from '../../db/schema/activity-log'
import type { ActivitySeverity, ObservabilityConfig } from './types'
import { decryptSecret } from '../ai/registry/crypto'
import { sendResendEmail } from './email'
import { loadObsConfig } from './config'

const ORDER: Record<'warn' | 'error', number> = { warn: 1, error: 2 }

export function shouldNotify(cfg: ObservabilityConfig, severity: ActivitySeverity): boolean {
  const e = cfg.alerts.email
  if (!e.enabled || !e.recipient || !e.apiKeyEnc) return false
  if (severity !== 'warn' && severity !== 'error') return false
  return ORDER[severity] >= ORDER[e.minSeverity]
}

export function buildDigest(rows: ActivityInsert[]): { subject: string, text: string } {
  const subject = `[MyMind] ${rows.length} error${rows.length === 1 ? '' : 's'} logged`
  const text = rows.map((r) => {
    const msg = (r.error as { message?: string } | null)?.message ?? ''
    return `• [${r.kind}] ${r.name}${r.provider ? ` (${r.provider})` : ''}: ${msg}`
  }).join('\n') + `\n\nSee /activity for full detail.`
  return { subject, text }
}

// Stateful digester: buffers eligible rows, sends one email per digest window.
export interface Digester { push: (rows: ActivityInsert[]) => void }

export function createEmailDigester(deps?: {
  send?: typeof sendResendEmail
  getConfig?: () => Promise<ObservabilityConfig>
  setTimer?: (fn: () => void, ms: number) => void
}): Digester {
  const send = deps?.send ?? sendResendEmail
  const getConfig = deps?.getConfig ?? loadObsConfig
  const setTimer = deps?.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
  let pending: ActivityInsert[] = []
  let armed = false

  async function fire() {
    armed = false
    const batch = pending; pending = []
    if (!batch.length) return
    try {
      const cfg = await getConfig()
      const e = cfg.alerts.email
      if (!e.enabled || !e.recipient || !e.apiKeyEnc) return
      const { subject, text } = buildDigest(batch)
      await send({ apiKey: decryptSecret(e.apiKeyEnc), from: e.from ?? 'mymind@localhost', to: e.recipient, subject, text })
    } catch (err) {
      console.error('[observability] email digest failed', err)
    }
  }

  return {
    push(rows) {
      getConfig().then((cfg) => {
        const eligible = rows.filter(r => shouldNotify(cfg, (r.severity as ActivitySeverity)))
        if (!eligible.length) return
        pending.push(...eligible)
        if (!armed) { armed = true; setTimer(() => { void fire() }, cfg.alerts.email.digestWindowMin * 60_000) }
      }).catch(() => {})
    }
  }
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `pnpm vitest run test/obs-notify.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add server/lib/observability/notify.ts server/lib/observability/email.ts test/obs-notify.test.ts
git commit -m "feat(observability): error email digest via Resend (severity-gated + windowed)"
```

---

## Task 7: Wire the production recorder singleton

**Files:**
- Modify: `server/lib/observability/record.ts` (append the singleton + re-exports)

- [ ] **Step 1: Append the wired singleton to `record.ts`**

Add at the bottom of `server/lib/observability/record.ts`:
```ts
import { useDb } from '../../db'
import { activityLog } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { createEmailDigester } from './notify'
import { loadObsConfig } from './config'
import type { ActivityKind } from './types'

const digester = createEmailDigester()

// Default, app-wired recorder. Capture toggles are honored at the seam by
// checking loadObsConfig(); the sink itself is dumb (writes whatever it's given).
export const recorder: Recorder = createRecorder({
  sink: async (rows) => {
    await useDb().insert(activityLog).values(rows)
  },
  publish: () => publishChange({ resource: 'activity', action: 'created', id: 'batch' }),
  notify: (rows) => digester.push(rows)
})

// A 1s flush loop + a 50-row eager flush keep latency off hot paths. unref so it
// never holds the process open. (No-op in tests — they call recorder.flush() directly.)
let flushTimer: ReturnType<typeof setInterval> | null = null
export function startRecorderFlushLoop(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => { void recorder.flush() }, 1_000)
  flushTimer.unref?.()
}

export const withSpan = recorder.withSpan
export const recordEvent = recorder.recordEvent
export const runInTrace = recorder.runInTrace

/** Seam guard: skip capture for a kind the user has disabled in settings. */
export async function captureEnabled(kind: ActivityKind): Promise<boolean> {
  try { return (await loadObsConfig()).capture[kind] !== false } catch { return true }
}
```

- [ ] **Step 2: Start the flush loop from a Nitro plugin**

Create `server/plugins/observe-flush.ts`:
```ts
import { startRecorderFlushLoop } from '../lib/observability/record'

export default defineNitroPlugin(() => {
  startRecorderFlushLoop()
})
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
```bash
git add server/lib/observability/record.ts server/plugins/observe-flush.ts
git commit -m "feat(observability): wire app recorder singleton (DB sink, live publish, email notify, flush loop)"
```

---

## Task 8: Instrument the failover chokepoint (TDD)

This is the highest-value seam — it makes the Anthropic empty-response bug class visible. Emit one `model` span around the whole `withFailoverOver` call and one `attempt` row per model tried.

**Files:**
- Modify: `server/lib/ai/registry/resolve.ts`
- Test: `test/obs-failover.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-failover.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { withFailoverOver } from '../server/lib/ai/registry/resolve'
import type { ResolvedModel } from '../server/lib/ai/registry/types'
import type { SpanInput } from '../server/lib/observability/types'

const chain: ResolvedModel[] = [
  { usage: 'reasoning', modelDefId: 'm1', providerKind: 'openai-compatible', baseURL: 'http://a', apiKey: 'k', modelId: 'broken', label: 'Broken', dim: null },
  { usage: 'reasoning', modelDefId: 'm2', providerKind: 'openai-compatible', baseURL: 'http://b', apiKey: 'k', modelId: 'good', label: 'Good', dim: null }
]

describe('withFailoverOver instrumentation', () => {
  it('records one attempt row per model tried, with statuses, via the injected recorder', async () => {
    const events: SpanInput[] = []
    const obs = { recordEvent: (e: SpanInput) => events.push(e) }
    const out = await withFailoverOver('reasoning', chain, async (m) => {
      if (m.modelId === 'broken') throw new Error('no usable content')
      return 'real answer'
    }, obs)
    expect(out).toBe('real answer')
    const attempts = events.filter(e => e.kind === 'attempt')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.status).toBe('error')
    expect(attempts[0]!.attempt).toBe(0)
    expect((attempts[0]!.error as { message: string }).message).toBe('no usable content')
    expect(attempts[1]!.status).toBe('ok')
    expect(attempts[1]!.attempt).toBe(1)
    // provider is host-only, never the apiKey
    expect(JSON.stringify(events)).not.toContain('"k"')
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-failover.test.ts`
Expected: FAIL — `withFailoverOver` takes 3 args today; the 4th `obs` arg + attempt records don't exist.

- [ ] **Step 3: Implement — modify `withFailoverOver`**

In `server/lib/ai/registry/resolve.ts`, replace the existing `withFailoverOver` and `withFailover`:
```ts
import { recordEvent as defaultRecord } from '../../observability/record'
import type { SpanInput } from '../../observability/types'

// Minimal seam so tests can inject without DB. Default = the app recorder.
interface ObsSeam { recordEvent: (e: SpanInput) => void }
const realObs: ObsSeam = { recordEvent: defaultRecord }

function providerHost(baseURL: string | null): string {
  if (!baseURL) return '(none)'
  try { return new URL(baseURL).host } catch { return baseURL }
}

/** Pure: run fn against each model in order until one succeeds. */
export async function withFailoverOver<T>(
  usage: Usage,
  chain: ResolvedModel[],
  fn: (m: ResolvedModel) => Promise<T>,
  obs: ObsSeam = realObs
): Promise<T> {
  const attempts: { label: string; error: string }[] = []
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i]!
    const started = Date.now()
    try {
      const out = await fn(m)
      obs.recordEvent({
        kind: 'attempt', name: `${usage}:${m.label}`, status: 'ok', severity: 'info',
        usage, provider: `${m.label}@${providerHost(m.baseURL)}`, modelId: m.modelId,
        attempt: i, durationMs: Date.now() - started
      })
      return out
    } catch (err) {
      const message = (err as Error).message
      attempts.push({ label: m.label, error: message })
      obs.recordEvent({
        kind: 'attempt', name: `${usage}:${m.label}`, status: 'error', severity: 'warn',
        usage, provider: `${m.label}@${providerHost(m.baseURL)}`, modelId: m.modelId,
        attempt: i, durationMs: Date.now() - started, error: { message }
      })
    }
  }
  obs.recordEvent({
    kind: 'model', name: `${usage}:all-failed`, status: 'error', severity: 'error',
    usage, error: { message: `all ${chain.length} models failed`, cause: JSON.stringify(attempts) }
  })
  throw new AiAllFailedError(usage, attempts)
}
```

Leave `withFailover` as-is (it already delegates to `withFailoverOver(usage, chain, fn)` — the new `obs` param defaults, so the app path logs automatically).

> Why `attempt` rows are `severity: 'warn'` not `'error'`: a single failed attempt that then fails over is expected/recoverable — only an exhausted chain (`all-failed`) is a true `error` worth alerting on. This keeps the badge/email focused on real failures, not routine failovers.

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run test/obs-failover.test.ts`
Expected: PASS. Also run the existing `pnpm vitest run test/ai-chat.test.ts` and `test/ai-registry-resolve.test.ts` — both must still PASS (the new 4th arg is optional).

- [ ] **Step 5: Commit**
```bash
git add server/lib/ai/registry/resolve.ts test/obs-failover.test.ts
git commit -m "feat(observability): record per-attempt model calls in withFailoverOver"
```

---

## Task 9: Wrap the four cron tasks in a job span

**Files:**
- Modify: `server/tasks/enrich-input.ts`, `server/tasks/embed-documents.ts`, `server/tasks/enrich-images.ts`, `server/tasks/enrich-memories.ts`

- [ ] **Step 1: Update `enrich-input.ts`**

Replace `server/tasks/enrich-input.ts` with:
```ts
import { runEnrichInput } from '../services/enrichment'
import { withSpan } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-input', description: 'Propose frontmatter for /input/* docs with sparse metadata' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-input' }, async () => {
      const r = await runEnrichInput({ limit: 20 })
      return r
    })
    return { result }
  }
})
```
> The job span's `response`/summary is attached by recording it inside the lambda; to surface the `{proposed, skipped}` summary on the row, wrap as below instead so the summary lands in `meta`:
```ts
import { runEnrichInput } from '../services/enrichment'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-input', description: 'Propose frontmatter for /input/* docs with sparse metadata' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-input' }, async () => {
      const r = await runEnrichInput({ limit: 20 })
      recordEvent({ kind: 'job', name: 'enrich-input:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
```
Use the second form (it nests a summary child under the job span carrying `{proposed, skipped}`).

- [ ] **Step 2: Apply the same pattern to the other three tasks**

For `embed-documents.ts`, `enrich-images.ts`, `enrich-memories.ts`: import `withSpan`/`recordEvent`, wrap the existing service call in `withSpan({ kind: 'job', name: '<task-name>' }, async () => { … })`, and emit a `:summary` `recordEvent` with the service's return object as `meta`. Keep each task's existing service call and return shape unchanged. Example for `embed-documents.ts` (adapt the service-call line to whatever it currently calls):
```ts
import { withSpan, recordEvent } from '../lib/observability/record'
// ...existing service import...

export default defineTask({
  meta: { name: 'embed-documents', description: 'Embed documents with empty vectors' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'embed-documents' }, async () => {
      const r = await runEmbedDocuments() // ← keep the existing call from the current file
      recordEvent({ kind: 'job', name: 'embed-documents:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
```
Read each task file first and preserve its exact existing service call/args.

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
```bash
git add server/tasks/enrich-input.ts server/tasks/embed-documents.ts server/tasks/enrich-images.ts server/tasks/enrich-memories.ts
git commit -m "feat(observability): wrap cron jobs in job spans + record run summaries"
```

---

## Task 10: Convert the swallowed-error sites in `enrichment.ts`

**Files:**
- Modify: `server/services/enrichment.ts`

- [ ] **Step 1: Replace the three console sites with structured records**

In `server/services/enrichment.ts`, add the import:
```ts
import { recordEvent } from '../lib/observability/record'
```
Then convert the loop's three console calls (keep the surrounding logic identical):

Replace the parse-failed warn:
```ts
      if (!proposal) {
        recordEvent({
          kind: 'job', name: 'enrich-input:parse-failed', status: 'warn', severity: 'warn',
          meta: { docId: doc.id, path: doc.path },
          error: { message: `proposeFrontmatter returned null (model produced no parseable proposal)` }
        })
        skipped++
        continue
      }
```
Replace the queued `console.log` (now an info record — optional but useful):
```ts
      if (inserted) {
        publishChange({ resource: 'review', action: 'created', id: inserted.id })
        recordEvent({ kind: 'job', name: 'enrich-input:queued', status: 'ok', severity: 'info', meta: { docId: doc.id, path: doc.path, reviewId: inserted.id } })
      }
```
Replace the catch-block `console.error`:
```ts
    } catch (err) {
      recordEvent({
        kind: 'job', name: 'enrich-input:doc-error', status: 'error', severity: 'error',
        meta: { docId: doc.id, path: doc.path },
        error: { message: (err as Error).message, stack: (err as Error).stack }
      })
      skipped++
    }
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck` then `pnpm vitest run test/enrich-parse.test.ts`
Expected: typecheck exit 0; the existing enrich-parse test still PASSES (we changed logging, not parsing).
```bash
git add server/services/enrichment.ts
git commit -m "feat(observability): surface enrichment parse-failed/errors as structured records"
```

---

## Task 11: Instrument the agent tool chokepoint

The single funnel for every tool call is `buildAiTools` in `server/lib/agent/ai-tools.ts` (it wraps each handler). Wrap each handler invocation in a `tool` span.

**Files:**
- Modify: `server/lib/agent/ai-tools.ts`

- [ ] **Step 1: Read the file, then wrap the handler call**

Read `server/lib/agent/ai-tools.ts`. It maps each registry tool to an AI-SDK tool whose `execute` calls the registry handler and pushes `tool-start`/`tool-result` via `onEvent`. Wrap the handler call in `withSpan`:
```ts
import { withSpan } from '../observability/record'
```
At the point where the handler is invoked (e.g. `const { result, summary, undo } = await tool.handler(args)`), change it to:
```ts
      const out = await withSpan(
        { kind: 'tool', name: tool.name, request: args as Record<string, unknown> },
        () => tool.handler(args)
      )
```
and keep using `out.result` / `out.summary` / `out.undo` exactly as before. Preserve the `onEvent({ type: 'tool-start' … })` / `tool-result` emissions — they are the live-UI signal and are independent of the activity log.

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck` then `pnpm vitest run test/ai-tools.test.ts test/agent-tools.test.ts`
Expected: typecheck exit 0; existing agent tool tests still PASS (the wrap is transparent — `withSpan` returns the handler result and re-throws on error).
```bash
git add server/lib/agent/ai-tools.ts
git commit -m "feat(observability): record agent tool calls as tool spans"
```

---

## Task 12: Inbound request capture (Nitro plugin)

Capture every authenticated `/api/**` request as a flat `inbound` row (method/path/status/who/duration). Metadata only — no bodies.

**Files:**
- Create: `server/plugins/observe-requests.ts`

- [ ] **Step 1: Write the plugin**

`server/plugins/observe-requests.ts`:
```ts
import { recordEvent, captureEnabled } from '../lib/observability/record'

const SKIP_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/events', '/api/activity']

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    if (event.path?.startsWith('/api/')) event.context._obsStart = Date.now()
  })

  nitroApp.hooks.hook('afterResponse', async (event) => {
    const path = event.path ?? ''
    const start = event.context._obsStart as number | undefined
    if (!start || !path.startsWith('/api/')) return
    if (SKIP_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) return
    if (!(await captureEnabled('inbound'))) return

    const status = event.node.res.statusCode
    const client = event.context.client as { type?: string, tokenId?: string, userId?: string } | undefined
    recordEvent({
      kind: 'inbound',
      name: `${event.method ?? 'GET'} ${path.split('?')[0]}`,
      status: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'ok',
      severity: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      durationMs: Date.now() - start,
      meta: { status, method: event.method, who: client?.type ?? 'anon', tokenId: client?.tokenId, userId: client?.userId }
    })
  })
})
```
> `/api/activity` and `/api/events` are skipped so opening the log page / SSE stream doesn't log itself into a feedback loop.

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0. (Behavioral verification happens in the final E2E task — this records via the real recorder.)
```bash
git add server/plugins/observe-requests.ts
git commit -m "feat(observability): capture inbound API requests (metadata only)"
```

---

## Task 13: Activity query service + where-builder (TDD the pure part)

**Files:**
- Create: `server/services/activity.ts`
- Test: `test/obs-activity-where.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-activity-where.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildActivityFilters } from '../server/services/activity'

describe('buildActivityFilters', () => {
  it('returns no filters for empty params', () => {
    expect(buildActivityFilters({})).toEqual([])
  })
  it('emits a filter descriptor per provided param', () => {
    const f = buildActivityFilters({ kind: 'model', status: 'error', severity: 'error', usage: 'reasoning', traceId: 't1' })
    const cols = f.map(x => x.col).sort()
    expect(cols).toEqual(['kind', 'severity', 'status', 'traceId', 'usage'])
  })
  it('passes q through as a name ILIKE descriptor', () => {
    const f = buildActivityFilters({ q: 'enrich' })
    expect(f[0]).toMatchObject({ col: 'name', op: 'ilike', value: '%enrich%' })
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-activity-where.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

`server/services/activity.ts`:
```ts
import { and, desc, eq, ilike, lt, isNull, count } from 'drizzle-orm'
import { useDb } from '../db'
import { activityLog } from '../db/schema'
import type { ActivityRow } from '../db/schema/activity-log'
import type { ActivityDTO, ActivityListParams, ActivityCount } from '../../shared/types/activity'

// Pure: describe the filters a set of params implies (unit-testable without drizzle).
export interface FilterDesc { col: string, op: 'eq' | 'ilike', value: unknown }
export function buildActivityFilters(p: ActivityListParams): FilterDesc[] {
  const f: FilterDesc[] = []
  if (p.kind) f.push({ col: 'kind', op: 'eq', value: p.kind })
  if (p.status) f.push({ col: 'status', op: 'eq', value: p.status })
  if (p.severity) f.push({ col: 'severity', op: 'eq', value: p.severity })
  if (p.usage) f.push({ col: 'usage', op: 'eq', value: p.usage })
  if (p.traceId) f.push({ col: 'traceId', op: 'eq', value: p.traceId })
  if (p.q?.trim()) f.push({ col: 'name', op: 'ilike', value: `%${p.q.trim()}%` })
  return f
}

function toDTO(r: ActivityRow): ActivityDTO {
  return {
    id: r.id, traceId: r.traceId, parentId: r.parentId, kind: r.kind as ActivityDTO['kind'],
    name: r.name, status: r.status as ActivityDTO['status'], severity: r.severity as ActivityDTO['severity'],
    usage: r.usage, provider: r.provider, modelId: r.modelId, attempt: r.attempt, durationMs: r.durationMs,
    tokens: r.tokens as ActivityDTO['tokens'], request: r.request, response: r.response,
    error: r.error as ActivityDTO['error'], meta: (r.meta ?? {}) as Record<string, unknown>,
    ackedAt: r.ackedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null
  }
}

const COL = {
  kind: activityLog.kind, status: activityLog.status, severity: activityLog.severity,
  usage: activityLog.usage, traceId: activityLog.traceId, name: activityLog.name
} as const

export async function listActivity(p: ActivityListParams): Promise<ActivityDTO[]> {
  const db = useDb()
  const conds = buildActivityFilters(p).map(f =>
    f.op === 'ilike' ? ilike(COL[f.col as keyof typeof COL], f.value as string) : eq(COL[f.col as keyof typeof COL], f.value as string)
  )
  if (p.before) conds.push(lt(activityLog.createdAt, new Date(p.before)))
  const rows = await db.select().from(activityLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(activityLog.createdAt))
    .limit(Math.min(p.limit ?? 100, 500))
  return rows.map(toDTO)
}

// Detail = the clicked row + every row sharing its trace_id (the full nested trace).
export async function getActivityTrace(id: string): Promise<{ root: ActivityDTO | null, trace: ActivityDTO[] }> {
  const db = useDb()
  const [row] = await db.select().from(activityLog).where(eq(activityLog.id, id)).limit(1)
  if (!row) return { root: null, trace: [] }
  const trace = await db.select().from(activityLog)
    .where(eq(activityLog.traceId, row.traceId)).orderBy(activityLog.createdAt)
  return { root: toDTO(row), trace: trace.map(toDTO) }
}

export async function countErrors(): Promise<ActivityCount> {
  const db = useDb()
  const [c] = await db.select({ n: count() }).from(activityLog)
    .where(and(eq(activityLog.status, 'error'), isNull(activityLog.ackedAt)))
  const [latest] = await db.select().from(activityLog)
    .where(and(eq(activityLog.status, 'error'), isNull(activityLog.ackedAt)))
    .orderBy(desc(activityLog.createdAt)).limit(1)
  return {
    unacked: c?.n ?? 0,
    latest: latest ? { id: latest.id, name: latest.name, severity: latest.severity as ActivityCount['latest'] extends infer L ? L extends { severity: infer S } ? S : never : never, at: latest.createdAt.toISOString() } : null
  }
}

export async function ackActivity(id: string): Promise<void> {
  await useDb().update(activityLog).set({ ackedAt: new Date() }).where(eq(activityLog.id, id))
}

export async function ackAllErrors(): Promise<void> {
  await useDb().update(activityLog).set({ ackedAt: new Date() })
    .where(and(eq(activityLog.status, 'error'), isNull(activityLog.ackedAt)))
}
```
> If the inline conditional type on `latest.severity` trips typecheck, simplify it to `severity: latest.severity as ActivitySeverity` and import `ActivitySeverity` from the shared types. Prefer the simple cast.

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run test/obs-activity-where.test.ts` then `pnpm typecheck`
Expected: test PASS; typecheck exit 0. (Fix the `severity` cast per the note if typecheck complains.)

- [ ] **Step 5: Commit**
```bash
git add server/services/activity.ts test/obs-activity-where.test.ts
git commit -m "feat(observability): activity query service (filters, trace detail, error count, ack)"
```

---

## Task 14: Activity API endpoints

**Files:**
- Create: `server/api/activity/index.get.ts`, `server/api/activity/[id].get.ts`, `server/api/activity/[id]/ack.post.ts`, `server/api/activity/ack-all.post.ts`, `server/api/activity/count.get.ts`

- [ ] **Step 1: List endpoint**

`server/api/activity/index.get.ts`:
```ts
import { listActivity } from '../../services/activity'
import type { ActivityListParams } from '../../../shared/types/activity'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const p: ActivityListParams = {
    kind: q.kind as ActivityListParams['kind'],
    status: q.status as ActivityListParams['status'],
    severity: q.severity as ActivityListParams['severity'],
    usage: q.usage ? String(q.usage) : undefined,
    traceId: q.traceId ? String(q.traceId) : undefined,
    q: q.q ? String(q.q) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    before: q.before ? String(q.before) : undefined
  }
  return listActivity(p)
})
```

- [ ] **Step 2: Detail (trace) endpoint**

`server/api/activity/[id].get.ts`:
```ts
import { getActivityTrace } from '../../services/activity'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await getActivityTrace(id)
  if (!result.root) throw createError({ statusCode: 404, statusMessage: 'Activity record not found' })
  return result
})
```

- [ ] **Step 3: Count endpoint**

`server/api/activity/count.get.ts`:
```ts
import { countErrors } from '../../services/activity'

export default defineEventHandler(async () => {
  return countErrors()
})
```

- [ ] **Step 4: Ack endpoints**

`server/api/activity/[id]/ack.post.ts`:
```ts
import { ackActivity } from '../../../services/activity'
import { publishChange } from '../../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await ackActivity(id)
  publishChange({ resource: 'activity', action: 'updated', id })
  return { ok: true }
})
```

`server/api/activity/ack-all.post.ts`:
```ts
import { ackAllErrors } from '../../services/activity'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async () => {
  await ackAllErrors()
  publishChange({ resource: 'activity', action: 'updated', id: 'all' })
  return { ok: true }
})
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
```bash
git add server/api/activity
git commit -m "feat(observability): /api/activity endpoints (list, trace detail, count, ack)"
```

---

## Task 15: Retention prune task (TDD the pure part)

**Files:**
- Create: `server/tasks/prune-activity-log.ts`
- Modify: `server/services/activity.ts` (add `pruneCutoffs` + `pruneActivity`)
- Modify: `nuxt.config.ts` (register the schedule)
- Test: `test/obs-prune.test.ts`

- [ ] **Step 1: Write the failing test**

`test/obs-prune.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pruneCutoffs } from '../server/services/activity'
import { DEFAULT_CONFIG } from '../server/lib/observability/types'

describe('pruneCutoffs', () => {
  it('computes info + error cutoffs from now and retention days', () => {
    const now = new Date('2026-06-15T00:00:00Z').getTime()
    const { infoCutoff, errorCutoff } = pruneCutoffs(DEFAULT_CONFIG, now)
    // info: 14 days back, error: 90 days back
    expect(infoCutoff.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(errorCutoff.toISOString()).toBe('2026-03-17T00:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/obs-prune.test.ts`
Expected: FAIL — `pruneCutoffs` not exported.

- [ ] **Step 3: Implement — add to `server/services/activity.ts`**

Append:
```ts
import { lte, ne, sql } from 'drizzle-orm'
import type { ObservabilityConfig } from '../lib/observability/types'

export function pruneCutoffs(cfg: ObservabilityConfig, now: number) {
  const day = 86_400_000
  return {
    infoCutoff: new Date(now - cfg.retainInfoDays * day),
    errorCutoff: new Date(now - cfg.retainErrorDays * day)
  }
}

export async function pruneActivity(cfg: ObservabilityConfig, now = Date.now()): Promise<{ deleted: number }> {
  const db = useDb()
  const { infoCutoff, errorCutoff } = pruneCutoffs(cfg, now)
  // non-error rows older than the info window
  const a = await db.delete(activityLog)
    .where(and(ne(activityLog.status, 'error'), lte(activityLog.createdAt, infoCutoff)))
    .returning({ id: activityLog.id })
  // error rows older than the (longer) error window
  const b = await db.delete(activityLog)
    .where(and(eq(activityLog.status, 'error'), lte(activityLog.createdAt, errorCutoff)))
    .returning({ id: activityLog.id })
  // hard row cap (oldest first) — delete anything beyond maxRows
  await db.execute(sql`
    DELETE FROM activity_log WHERE id IN (
      SELECT id FROM activity_log ORDER BY created_at DESC OFFSET ${cfg.maxRows}
    )`)
  return { deleted: a.length + b.length }
}
```

- [ ] **Step 4: Write the task**

`server/tasks/prune-activity-log.ts`:
```ts
import { pruneActivity } from '../services/activity'
import { loadObsConfig } from '../lib/observability/config'
import { withSpan } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'prune-activity-log', description: 'Tiered retention prune of the activity log' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'prune-activity-log' }, async () => {
      const cfg = await loadObsConfig()
      return pruneActivity(cfg)
    })
    return { result }
  }
})
```

- [ ] **Step 5: Register the schedule**

In `nuxt.config.ts`, add to the `scheduledTasks` map:
```ts
      '0 3 * * *': ['prune-activity-log']
```
(daily at 03:00).

- [ ] **Step 6: Verify + commit**

Run: `pnpm vitest run test/obs-prune.test.ts` then `pnpm typecheck`
Expected: test PASS; typecheck exit 0.
```bash
git add server/tasks/prune-activity-log.ts server/services/activity.ts nuxt.config.ts test/obs-prune.test.ts
git commit -m "feat(observability): daily tiered retention prune"
```

---

## Task 16: Register `activity` as a live resource (TDD)

**Files:**
- Modify: `shared/types/live.ts`
- Modify: `app/utils/live-dispatch.ts`
- Test: `test/live-dispatch.test.ts` (add cases)

- [ ] **Step 1: Add the failing test cases**

Append to `test/live-dispatch.test.ts` (mirror the existing fake-client pattern in that file — it constructs a client with a spy `invalidateQueries`):
```ts
import { describe, it, expect, vi } from 'vitest'
import { dispatchLiveEvent } from '../app/utils/live-dispatch'

describe('dispatchLiveEvent — activity', () => {
  it('invalidates activity list + count on an activity signal', () => {
    const invalidateQueries = vi.fn()
    dispatchLiveEvent({ invalidateQueries }, { v: 1, resource: 'activity', action: 'created', id: 'batch', at: 0 })
    const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keys).toContain(JSON.stringify(['activity', 'list']))
    expect(keys).toContain(JSON.stringify(['activity', 'count']))
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run test/live-dispatch.test.ts`
Expected: FAIL — `'activity'` is not a `ResourceName`, and no override invalidates `['activity','count']`.

- [ ] **Step 3: Add `'activity'` to the union**

In `shared/types/live.ts`, add to `ResourceName`:
```ts
  | 'activity'
```

- [ ] **Step 4: Add the dispatch override**

In `app/utils/live-dispatch.ts`, add to `OVERRIDES`:
```ts
  activity: (c) => c.invalidateQueries({ queryKey: ['activity', 'count'] })
```
(The default already invalidates `['activity', e.id]` and `['activity', 'list']`; the override adds the count.)

- [ ] **Step 5: Run it — verify it passes**

Run: `pnpm vitest run test/live-dispatch.test.ts` then `pnpm typecheck`
Expected: PASS; typecheck exit 0 (the `ResourceName` union now includes `activity`, so the recorder's `publishChange({ resource: 'activity' … })` from Task 7 typechecks).

- [ ] **Step 6: Commit**
```bash
git add shared/types/live.ts app/utils/live-dispatch.ts test/live-dispatch.test.ts
git commit -m "feat(observability): register 'activity' as a live resource (list+count invalidation)"
```

---

## Task 17: Settings config endpoints + composable + tab

**Files:**
- Create: `server/api/settings/observability-config.get.ts`, `server/api/settings/observability-config.put.ts`
- Create: `app/composables/useObservabilityConfig.ts`
- Create: `app/components/settings/ActivityAlertsTab.vue`
- Modify: `app/pages/settings.vue`

- [ ] **Step 1: GET endpoint (redacted read)**

`server/api/settings/observability-config.get.ts`:
```ts
import { loadObsConfig, redactObsConfig } from '../../lib/observability/config'

export default defineEventHandler(async () => {
  return redactObsConfig(await loadObsConfig())
})
```

- [ ] **Step 2: PUT endpoint (write-only key)**

`server/api/settings/observability-config.put.ts`:
```ts
import { z } from 'zod'
import { loadObsConfig, saveObsConfig, invalidateObsConfig, parseObsConfig } from '../../lib/observability/config'
import { encryptSecret } from '../../lib/ai/registry/crypto'
import { ACTIVITY_KINDS } from '../../../shared/types/activity'

const KeyField = z.union([z.object({ apiKey: z.string().min(1) }), z.object({ keep: z.literal(true) }), z.null()])
const Body = z.object({
  version: z.literal(1),
  retainInfoDays: z.number().int().positive(),
  retainErrorDays: z.number().int().positive(),
  maxRows: z.number().int().positive(),
  capture: z.object(Object.fromEntries(ACTIVITY_KINDS.map(k => [k, z.boolean()]))),
  alerts: z.object({
    badge: z.boolean(),
    toast: z.boolean(),
    email: z.object({
      enabled: z.boolean(),
      recipient: z.string().email().nullable(),
      from: z.string().email().nullable(),
      key: KeyField,
      minSeverity: z.enum(['warn', 'error']),
      digestWindowMin: z.number().int().positive()
    })
  })
})

export default defineEventHandler(async (event) => {
  let body: z.infer<typeof Body>
  try { body = Body.parse(await readBody(event)) }
  catch (err) { throw createError({ statusCode: 422, statusMessage: 'Invalid config', data: (err as Error).message }) }

  const existing = await loadObsConfig()
  let apiKeyEnc: string | null = null
  const k = body.alerts.email.key
  if (k && 'apiKey' in k) apiKeyEnc = encryptSecret(k.apiKey)
  else if (k && 'keep' in k) apiKeyEnc = existing.alerts.email.apiKeyEnc
  else apiKeyEnc = null

  const doc = parseObsConfig({
    version: 1,
    retainInfoDays: body.retainInfoDays,
    retainErrorDays: body.retainErrorDays,
    maxRows: body.maxRows,
    capture: body.capture,
    alerts: {
      badge: body.alerts.badge,
      toast: body.alerts.toast,
      email: {
        enabled: body.alerts.email.enabled,
        recipient: body.alerts.email.recipient,
        from: body.alerts.email.from,
        apiKeyEnc,
        minSeverity: body.alerts.email.minSeverity,
        digestWindowMin: body.alerts.email.digestWindowMin
      }
    }
  })
  await saveObsConfig(doc)
  invalidateObsConfig()
  return { ok: true }
})
```

- [ ] **Step 3: The composable**

`app/composables/useObservabilityConfig.ts`:
```ts
import type { ActivityKind } from '~~/shared/types/activity'

type KeyField = { apiKey: string } | { keep: true } | null
interface DraftEmail { enabled: boolean, recipient: string | null, from: string | null, hasKey: boolean, key: KeyField, minSeverity: 'warn' | 'error', digestWindowMin: number }
export interface DraftObsConfig {
  version: 1
  retainInfoDays: number
  retainErrorDays: number
  maxRows: number
  capture: Record<ActivityKind, boolean>
  alerts: { badge: boolean, toast: boolean, email: DraftEmail }
}

export function useObservabilityConfig() {
  const draft = useState<DraftObsConfig | null>('obs-config-draft', () => null)
  const loaded = useState<boolean>('obs-config-loaded', () => false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function load(force = false) {
    if (loaded.value && !force) return
    const doc = await $fetch<DraftObsConfig & { alerts: { email: DraftEmail & { hasKey: boolean } } }>('/api/settings/observability-config')
    draft.value = {
      ...doc,
      alerts: { ...doc.alerts, email: { ...doc.alerts.email, key: doc.alerts.email.hasKey ? { keep: true } : null } }
    }
    loaded.value = true
  }

  async function save() {
    if (!draft.value) return
    saving.value = true; error.value = null
    try {
      const d = draft.value
      await $fetch('/api/settings/observability-config', {
        method: 'PUT',
        body: {
          version: 1,
          retainInfoDays: d.retainInfoDays, retainErrorDays: d.retainErrorDays, maxRows: d.maxRows,
          capture: d.capture,
          alerts: {
            badge: d.alerts.badge, toast: d.alerts.toast,
            email: {
              enabled: d.alerts.email.enabled, recipient: d.alerts.email.recipient, from: d.alerts.email.from,
              key: d.alerts.email.key, minSeverity: d.alerts.email.minSeverity, digestWindowMin: d.alerts.email.digestWindowMin
            }
          }
        }
      })
      await load(true)
    } catch (err) {
      error.value = (err as { data?: { data?: string }, message?: string }).data?.data ?? (err as Error).message
      throw err
    } finally { saving.value = false }
  }

  return { draft, loaded, saving, error, load, save }
}
```

- [ ] **Step 4: The settings tab component**

`app/components/settings/ActivityAlertsTab.vue` (mirrors `ProvidersTab.vue` structure):
```vue
<script setup lang="ts">
const config = useObservabilityConfig()
onMounted(() => config.load())
const kinds = ['inbound', 'job', 'model', 'attempt', 'tool'] as const
const severityItems = [{ label: 'Errors only', value: 'error' }, { label: 'Warnings + errors', value: 'warn' }]
</script>

<template>
  <div v-if="config.draft.value" class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Retention</h2>
      <p class="text-sm text-muted">Errors are kept longer than routine activity. A daily job prunes the rest.</p>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <UFormField label="Keep info (days)"><UInputNumber v-model="config.draft.value.retainInfoDays" :min="1" /></UFormField>
        <UFormField label="Keep errors (days)"><UInputNumber v-model="config.draft.value.retainErrorDays" :min="1" /></UFormField>
        <UFormField label="Max rows"><UInputNumber v-model="config.draft.value.maxRows" :min="1000" :step="1000" /></UFormField>
      </div>
    </div>

    <div>
      <h2 class="text-base font-semibold text-highlighted">Capture</h2>
      <p class="text-sm text-muted">Silence a noisy source without losing the rest.</p>
      <div class="mt-3 flex flex-wrap gap-4">
        <USwitch v-for="k in kinds" :key="k" v-model="config.draft.value.capture[k]" :label="k" />
      </div>
    </div>

    <div>
      <h2 class="text-base font-semibold text-highlighted">Alerts</h2>
      <div class="mt-3 flex flex-col gap-3">
        <USwitch v-model="config.draft.value.alerts.badge" label="Sidebar error badge" />
        <USwitch v-model="config.draft.value.alerts.toast" label="In-app toast on new errors" />
        <USwitch v-model="config.draft.value.alerts.email.enabled" label="Email me (Resend)" />
        <div v-if="config.draft.value.alerts.email.enabled" class="grid grid-cols-1 sm:grid-cols-2 gap-3 border-l-2 border-default pl-4">
          <UFormField label="Recipient"><UInput v-model="config.draft.value.alerts.email.recipient" type="email" placeholder="you@example.com" /></UFormField>
          <UFormField label="From"><UInput v-model="config.draft.value.alerts.email.from" type="email" placeholder="mymind@yourdomain" /></UFormField>
          <UFormField label="Resend API key" :help="config.draft.value.alerts.email.hasKey ? 'A key is set. Type to replace.' : 'Required to send.'">
            <UInput type="password" placeholder="re_…" @update:model-value="v => config.draft.value!.alerts.email.key = v ? { apiKey: v } : { keep: true }" />
          </UFormField>
          <UFormField label="Threshold"><USelect v-model="config.draft.value.alerts.email.minSeverity" :items="severityItems" value-key="value" /></UFormField>
          <UFormField label="Digest window (min)"><UInputNumber v-model="config.draft.value.alerts.email.digestWindowMin" :min="1" /></UFormField>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="config.saving.value" @click="config.save()" />
      <UAlert v-if="config.error.value" color="error" icon="i-lucide-alert-circle" :title="config.error.value" class="flex-1" />
    </div>
  </div>
</template>
```

- [ ] **Step 5: Register the tab in `settings.vue`**

In `app/pages/settings.vue`, add to the `tabs` array:
```ts
  { label: 'Activity & Alerts', icon: 'i-lucide-activity', slot: 'activity' as const }
```
and add the template slot inside `<UTabs>`:
```vue
          <template #activity><SettingsActivityAlertsTab /></template>
```

- [ ] **Step 6: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
```bash
git add server/api/settings/observability-config.get.ts server/api/settings/observability-config.put.ts app/composables/useObservabilityConfig.ts app/components/settings/ActivityAlertsTab.vue app/pages/settings.vue
git commit -m "feat(observability): Activity & Alerts settings tab + config endpoints"
```

---

## Task 18: `/activity` list page + detail (trace tree)

**Files:**
- Create: `app/composables/useActivityLog.ts`
- Create: `app/pages/activity/index.vue`
- Create: `app/pages/activity/[id].vue`

- [ ] **Step 1: The composable**

`app/composables/useActivityLog.ts`:
```ts
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ActivityDTO, ActivityListParams } from '~~/shared/types/activity'

export function useActivityLog() {
  const useActivityList = (params?: MaybeRefOrGetter<ActivityListParams | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: computed(() => ['activity', 'list', key.value] as const),
      queryFn: () => $fetch<ActivityDTO[]>('/api/activity', { query: key.value })
    })
  }

  const useActivityDetail = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['activity', key.value] as const),
      queryFn: () => $fetch<{ root: ActivityDTO, trace: ActivityDTO[] }>(`/api/activity/${key.value}`),
      enabled: computed(() => !!key.value)
    })
  }

  return { useActivityList, useActivityDetail }
}
```

- [ ] **Step 2: The list page**

`app/pages/activity/index.vue` (mirrors `sessions/index.vue`; adds a live-tail pause toggle):
```vue
<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'
import type { ActivityListParams, ActivityDTO } from '~~/shared/types/activity'

definePageMeta({ title: 'Activity' })
const toast = useToast()
const { useActivityList } = useActivityLog()

const paused = ref(false)
const kind = ref<string>('__all__')
const status = ref<string>('__all__')
const q = ref('')

const params = computed<ActivityListParams>(() => ({
  kind: kind.value === '__all__' ? undefined : (kind.value as ActivityDTO['kind']),
  status: status.value === '__all__' ? undefined : (status.value as ActivityDTO['status']),
  q: q.value.trim() || undefined,
  limit: 200
}))

// When paused, freeze the query key so live invalidations don't refetch the visible page.
const frozen = ref<ActivityListParams>(params.value)
watch(params, v => { if (!paused.value) frozen.value = v })
watch(paused, p => { if (!p) frozen.value = params.value })

const { data, isPending: loading, error } = useActivityList(() => paused.value ? frozen.value : params.value)
const rows = computed(() => data.value ?? [])

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load activity', description: e.data?.statusMessage ?? e.message })
})

const kindItems = [{ label: 'All kinds', value: '__all__' }, ...['inbound', 'job', 'model', 'attempt', 'tool'].map(k => ({ label: k, value: k }))]
const statusItems = [{ label: 'All', value: '__all__' }, { label: 'OK', value: 'ok' }, { label: 'Warn', value: 'warn' }, { label: 'Error', value: 'error' }]

function statusColor(s: string): 'success' | 'warning' | 'error' | 'neutral' {
  return s === 'ok' ? 'success' : s === 'warn' ? 'warning' : s === 'error' ? 'error' : 'neutral'
}
function rel(iso: string) { return useTimeAgo(new Date(iso)).value }
</script>

<template>
  <UDashboardPanel id="activity" grow :ui="{ body: '!p-0' }">
    <template #header>
      <UDashboardNavbar title="Activity">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <UButton
            :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
            :label="paused ? 'Resume' : 'Pause'"
            color="neutral" variant="subtle" size="sm"
            @click="paused = !paused"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-5xl mx-auto w-full">
        <div class="flex flex-col sm:flex-row gap-3 flex-wrap">
          <UInput v-model="q" placeholder="Search by name…" icon="i-lucide-search" class="w-full sm:flex-1" />
          <USelect v-model="kind" :items="kindItems" value-key="value" class="w-40 shrink-0" />
          <USelect v-model="status" :items="statusItems" value-key="value" class="w-32 shrink-0" />
        </div>

        <div v-if="loading" class="space-y-2">
          <USkeleton v-for="i in 8" :key="i" class="h-14 w-full rounded-lg" />
        </div>

        <div v-else-if="!rows.length" class="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <UIcon name="i-lucide-activity" class="size-12 text-muted" />
          <p class="text-sm font-medium text-muted">No activity yet</p>
        </div>

        <template v-else>
          <UCard
            v-for="r in rows" :key="r.id"
            class="cursor-pointer hover:bg-elevated/50 transition-colors"
            :ui="{ body: '!p-3' }"
            @click="navigateTo('/activity/' + r.id)"
          >
            <div class="flex items-center gap-3 flex-wrap">
              <UBadge :label="r.kind" color="neutral" variant="subtle" size="xs" />
              <UBadge :label="r.status" :color="statusColor(r.status)" variant="subtle" size="xs" />
              <span class="text-sm font-medium text-default truncate flex-1 min-w-0">{{ r.name }}</span>
              <span v-if="r.provider" class="text-xs text-dimmed hidden sm:inline">{{ r.provider }}</span>
              <span v-if="r.durationMs != null" class="text-xs text-dimmed">{{ r.durationMs }}ms</span>
              <span class="text-xs text-dimmed">{{ rel(r.createdAt) }}</span>
            </div>
            <p v-if="r.error" class="mt-1 text-xs text-error truncate">{{ (r.error as { message?: string }).message }}</p>
          </UCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 3: The detail page (trace tree)**

`app/pages/activity/[id].vue`:
```vue
<script setup lang="ts">
import type { ActivityDTO } from '~~/shared/types/activity'

const route = useRoute()
const { useActivityDetail } = useActivityLog()
const { data, isPending } = useActivityDetail(() => route.params.id as string)

// Order the trace as a parent→child tree, computing an indent depth per row.
const tree = computed<(ActivityDTO & { depth: number })[]>(() => {
  const trace = data.value?.trace ?? []
  const byParent = new Map<string | null, ActivityDTO[]>()
  for (const r of trace) {
    const k = r.parentId
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k)!.push(r)
  }
  const out: (ActivityDTO & { depth: number })[] = []
  const ids = new Set(trace.map(r => r.id))
  const walk = (parent: string | null, depth: number) => {
    for (const r of byParent.get(parent) ?? []) { out.push({ ...r, depth }); walk(r.id, depth + 1) }
  }
  // roots = rows whose parent isn't in this trace (covers the true root + orphans)
  for (const r of trace) if (!r.parentId || !ids.has(r.parentId)) { out.push({ ...r, depth: 0 }); walk(r.id, 1) }
  return out.length ? out : trace.map(r => ({ ...r, depth: 0 }))
})

function statusColor(s: string): 'success' | 'warning' | 'error' | 'neutral' {
  return s === 'ok' ? 'success' : s === 'warn' ? 'warning' : s === 'error' ? 'error' : 'neutral'
}
function pretty(v: unknown) { return v == null ? '' : JSON.stringify(v, null, 2) }
const toast = useToast()
async function ack(id: string) {
  await $fetch(`/api/activity/${id}/ack`, { method: 'POST' })
  toast.add({ color: 'success', title: 'Acknowledged' })
}
</script>

<template>
  <UDashboardPanel id="activity-detail" grow>
    <template #header>
      <UDashboardNavbar title="Activity trace">
        <template #leading><UButton icon="i-lucide-arrow-left" variant="ghost" color="neutral" @click="navigateTo('/activity')" /></template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="p-4 max-w-4xl mx-auto w-full space-y-3">
        <USkeleton v-if="isPending" class="h-40 w-full" />
        <template v-else>
          <UCard v-for="r in tree" :key="r.id" :ui="{ body: '!p-3' }">
            <div class="flex items-center gap-2 flex-wrap" :style="{ paddingLeft: `${r.depth * 16}px` }">
              <UBadge :label="r.kind" color="neutral" variant="subtle" size="xs" />
              <UBadge :label="r.status" :color="statusColor(r.status)" variant="subtle" size="xs" />
              <span class="text-sm font-medium">{{ r.name }}</span>
              <span v-if="r.durationMs != null" class="text-xs text-dimmed">{{ r.durationMs }}ms</span>
              <UButton v-if="r.status === 'error' && !r.ackedAt" label="Ack" size="xs" color="neutral" variant="ghost" class="ml-auto" @click="ack(r.id)" />
            </div>
            <div v-if="r.error" class="mt-2 text-xs text-error"><pre class="whitespace-pre-wrap">{{ pretty(r.error) }}</pre></div>
            <details v-if="r.request" class="mt-2"><summary class="text-xs text-muted cursor-pointer">request</summary><pre class="text-xs whitespace-pre-wrap mt-1 text-dimmed">{{ pretty(r.request) }}</pre></details>
            <details v-if="r.response" class="mt-1"><summary class="text-xs text-muted cursor-pointer">response</summary><pre class="text-xs whitespace-pre-wrap mt-1 text-dimmed">{{ pretty(r.response) }}</pre></details>
            <details v-if="Object.keys(r.meta || {}).length" class="mt-1"><summary class="text-xs text-muted cursor-pointer">meta</summary><pre class="text-xs whitespace-pre-wrap mt-1 text-dimmed">{{ pretty(r.meta) }}</pre></details>
          </UCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
```bash
git add app/composables/useActivityLog.ts app/pages/activity
git commit -m "feat(observability): /activity list (live-tail pause) + trace-tree detail"
```

---

## Task 19: Sidebar nav item + error badge + toast watcher

**Files:**
- Modify: `app/layouts/default.vue`

- [ ] **Step 1: Add the count query + toast watcher**

In `app/layouts/default.vue` `<script setup>`, add alongside the existing `reviewCount`/`memoryCount` queries:
```ts
import type { ActivityCount } from '~~/shared/types/activity'

const { data: activityCount } = useQuery({
  queryKey: ['activity', 'count'],
  queryFn: () => $fetch<ActivityCount>('/api/activity/count')
})

const toast = useToast()
// Toast when a new unacked error appears (latest.id changes to a new value).
watch(() => activityCount.value?.latest?.id, (id, prev) => {
  if (!id || prev === undefined) return // skip initial load
  if (id === prev) return
  toast.add({
    color: 'error',
    title: 'New error logged',
    description: activityCount.value?.latest?.name ?? 'See Activity',
    actions: [{ label: 'View', onClick: () => navigateTo('/activity/' + id) }]
  })
})
```

- [ ] **Step 2: Add the nav item with the badge**

In the `mainItems` computed array, add an Activity entry (place it after `Sessions`):
```ts
  {
    label: 'Activity',
    icon: 'i-lucide-activity',
    to: '/activity',
    badge: (activityCount.value?.unacked ?? 0) > 0 ? activityCount.value!.unacked : undefined
  },
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: exit 0.
> If `UButton`/toast `actions` typing complains about `onClick`, use `click` instead per the installed Nuxt UI version (check an existing `actions: [...]` toast usage in the repo; match its key).
```bash
git add app/layouts/default.vue
git commit -m "feat(observability): sidebar Activity badge + new-error toast"
```

---

## Task 20: Full verification + wiki/docs + handover

**Files:**
- Create: `docs/wiki/activity-log.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (add the cycle row)
- Modify: `docs/BACKLOG.md` (tick Email/ReSend + note the notification-surfacing overlap)
- Create: `docs/handovers/2026-06-15-activity-log.md`

- [ ] **Step 1: Run the full gate**

Run, in order:
```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:migrate
```
Expected: typecheck exit 0; **all tests pass** (existing suite + the 7 new `obs-*` files + the live-dispatch additions); build exit 0; migrate clean (idempotent).

- [ ] **Step 2: Manual E2E smoke (dev server)**

Start `pnpm dev`, sign in, then:
1. Trigger a cron run: `curl -X POST http://localhost:3000/_nitro/tasks/enrich-input` (or wait for the schedule). Open `/activity` → a `job enrich-input` row appears live (no reload), with a `:summary` child carrying `{proposed, skipped}`.
2. Click a row → the detail page shows the nested trace (job → model → attempt rows).
3. Force a failure: in `/settings` → Providers, point the primary reasoning provider's baseURL at a bad host, save, trigger `enrich-input` again → an `all-failed` **error** row appears, the sidebar **Activity badge** increments, and (if you're on another page) a **toast** pops. Restore the provider.
4. In `/settings` → Activity & Alerts: toggle `email.enabled` on with a Resend key + recipient; force another error; confirm one digest email arrives within the window (or check the `email digest failed` log line is absent). Toggle off.
5. Confirm `capture.embeddings`/`model` toggle off silences those rows.

Record the evidence (row counts, screenshots/log lines) for the handover.

- [ ] **Step 3: Write the wiki page**

Create `docs/wiki/activity-log.md` with `status: shipped`, documenting: the `activity_log` schema, the `withSpan`/`recordEvent` primitive + ALS nesting, the five seams (table), the redaction rules, retention/prune, the live wiring (`activity` resource), the three alert channels, and the settings doc. Follow the format of `docs/wiki/live-reactivity.md`.

- [ ] **Step 4: Update roadmap + backlog**

- Add a cycle row (22) to `docs/superpowers/plans/00-roadmap.md` Round-3 table: **Activity Log — centralized observability**, status `✅ shipped`, linking spec/plan/handover.
- In `docs/BACKLOG.md`: tick **Email (ReSend)** as now shipped (error alerting), and add a note under §3 that `error`-kind activity rows are the seam for the cycle-15 "surface ocr-failed / ambiguous-project to the notification queue" item (overlap, not duplication).

- [ ] **Step 5: Write the handover**

Create `docs/handovers/2026-06-15-activity-log.md` with accurate frontmatter (`title`, `cycle: 22`, `date`, `status: shipped`, `wiki:`, `shipped:` list, `deferred:` list). In `deferred:`, record: no separate `running` in-flight row (single completion row); inbound rows are flat (not parents of the work they trigger — ALS-wrapping the handler is the future seam); the prune row-cap uses an `OFFSET` delete (fine at this scale, revisit if the table gets huge); per-user scoping not built (single-user).

- [ ] **Step 6: Commit**
```bash
git add docs/wiki/activity-log.md docs/superpowers/plans/00-roadmap.md docs/BACKLOG.md docs/handovers/2026-06-15-activity-log.md
git commit -m "docs(observability): wiki + roadmap + backlog + handover for the activity log"
```

---

## Self-review (planner — completed)

**Spec coverage:** breadth (inbound/job/model/attempt/tool) → Tasks 8–12; unified table + correlation → Tasks 1, 5; capture safety/non-interference → Task 5 (tested); per-kind redaction → Task 3; tiered retention → Task 15; live UI via the cycle-21 convention → Tasks 16, 18; badge+toast+email → Tasks 6, 17, 19; settings doc → Tasks 4, 17; swallowed-error conversion → Task 10. All spec sections map to a task.

**Placeholder scan:** every code step shows complete code; the two spots flagged for environment variance (the `severity` cast in Task 13, the toast `actions` key in Task 19) give an explicit fallback rather than a TODO.

**Type consistency:** `SpanInput`/`ActivityInsert`/`ObservabilityConfig` defined in Task 2 are used unchanged in Tasks 3–19; `createRecorder`/`withSpan`/`recordEvent` signatures match between Task 5 (def), Task 7 (singleton), and Tasks 8–12 (callers); `ActivityDTO`/`ActivityListParams`/`ActivityCount` (Task 2) match the service (Task 13), endpoints (Task 14), composable + pages (Task 18), and layout (Task 19); `'activity'` added to `ResourceName` (Task 16) before the recorder's `publishChange` is type-checked at the gate.

**Scope:** one cohesive cycle (one table, one capture lib, five seams, query API, prune, live UI, settings) — does not need decomposition.
