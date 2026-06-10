# AI Config Registry — Backend + API (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace env-based AI config with a database-backed registry: one JSONB document (providers → models → per-usage failover chains), encrypted API keys, a centralized resolver with failover, all 7 AI consumers refactored to read it, and 3 admin API endpoints. Plan 2 adds the Settings UI + onboarding on top.

**Architecture:** A single `settings(key='ai_config')` JSONB row, zod-validated. `server/lib/ai/registry/` holds pure cores (crypto, schema, resolve) plus thin DB I/O (store). Consumers call `resolveChain(usage)` / `withFailover(usage, fn)` instead of `useRuntimeConfig().ai`. Keys are AES-256-GCM encrypted with a key derived from `BETTER_AUTH_SECRET`.

**Tech Stack:** Nuxt 4 (Nitro), Drizzle + Postgres, zod, Node `crypto`, Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible`, new `@ai-sdk/anthropic`), vitest.

**Branch & deploy safety:** Execute on a feature branch `feat/ai-config-registry`. This plan deletes the `AI_*` env path; with no UI yet, AI is configured via the API (curl/tests) only. **Do NOT merge to master until Plan 2's onboarding ships** — CI auto-deploys master and you chose no env fallback, so a half-merge would dark prod AI with no UI to fix it.

**Conventions (from this repo):**
- Tests are pure vitest, no DB — so each module splits a **pure core** (unit-tested) from **thin DB/SDK I/O** (covered later by curl/E2E). Tests live in `test/*.test.ts` and import via relative paths (`../server/lib/...`).
- `noUncheckedIndexedAccess` is on — guard array/record indexing with `!`/`?? fallback`.
- Lint is red repo-wide and NOT a gate. Gates: `pnpm test`, `pnpm typecheck`, `pnpm build`.
- Commit after every task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/db/schema/settings.ts` | Create | `settings` table (`key` PK, `value` jsonb, timestamps) |
| `server/db/schema/index.ts` | Modify | re-export `./settings` |
| `server/db/migrations/00NN_*.sql` | Generate | `pnpm db:generate` output |
| `server/lib/ai/registry/types.ts` | Create | `AiConfigDoc`, `Usage`, `ResolvedModel`, `USAGES`, `EMBEDDING_DIM`, default-doc |
| `server/lib/ai/registry/crypto.ts` | Create | `encryptSecret` / `decryptSecret` (AES-256-GCM, HKDF key) |
| `server/lib/ai/registry/schema.ts` | Create | zod schema + referential refinement, `parseConfig`, `redactDoc` |
| `server/lib/ai/registry/errors.ts` | Create | `AiNotConfiguredError`, `AiAllFailedError`, `ConfigValidationError` |
| `server/lib/ai/registry/resolve.ts` | Create | pure `resolveChainFrom`, `withFailoverOver`, `languageModel`; cached `getConfig`/`resolveChain`/`withFailover` |
| `server/lib/ai/registry/store.ts` | Create | DB load/save of the JSONB row + in-process cache + `invalidate` |
| `server/lib/agent/model.ts` | Modify | `reasoningModel()` → registry-resolved primary |
| `server/lib/agent/run.ts` | Modify | start-only failover over the reasoning chain |
| `server/lib/ai/embeddings.ts` | Modify | config from resolver |
| `server/lib/ai/chat.ts` | Modify | config from resolver + failover |
| `server/lib/ai/vision.ts` | Modify | config from resolver + failover |
| `server/lib/ai/rerank.ts` | Modify | caller resolves; keep arg signature |
| `server/services/memory.ts` | Modify (if it passes rerank cfg) | source rerank cfg from resolver |
| `server/lib/voice/providers/index.ts` | Modify | `makeStt/makeTts/defaultVoice` take a `ResolvedModel` |
| `server/api/voice/ws.ts` | Modify | resolve stt/tts chains via failover |
| `server/api/voice/voices.get.ts` | Modify | list voices for resolved tts provider(s) |
| `server/lib/ai/provider.ts` | Delete | `aiProvider` removed |
| `nuxt.config.ts` | Modify | delete `runtimeConfig.ai` block |
| `docker-compose.prod.yml` | Modify | delete the 25 `NUXT_AI_*` mappings |
| `.env.example` | Modify | delete `AI_*` block; add optional `CONFIG_ENC_KEY` note |
| `server/api/settings/ai-config.get.ts` | Create | redacted doc |
| `server/api/settings/ai-config.put.ts` | Create | validate, encrypt, dim-probe, save, invalidate |
| `server/api/settings/test-provider.post.ts` | Create | ping a provider |
| `test/ai-registry-crypto.test.ts` | Create | crypto roundtrip/tamper |
| `test/ai-registry-schema.test.ts` | Create | zod + refinement + redact |
| `test/ai-registry-resolve.test.ts` | Create | resolveChainFrom + withFailoverOver + languageModel |

---

### Task 1: `settings` table + migration

**Files:**
- Create: `server/db/schema/settings.ts`
- Modify: `server/db/schema/index.ts`
- Generate: a migration under `server/db/migrations/`

- [ ] **Step 1: Create the schema file**

```ts
// server/db/schema/settings.ts
import { sql } from 'drizzle-orm'
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core'

// Generic single-row-per-key settings store. The AI config registry uses
// key='ai_config'; the value is the full zod-validated config document.
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})
export type SettingRow = typeof settings.$inferSelect
```

- [ ] **Step 2: Re-export from the schema index**

Add to `server/db/schema/index.ts`:

```ts
export * from './settings'
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/00NN_*.sql` creating `settings`, and an updated snapshot. Do not hand-edit it.

- [ ] **Step 4: Apply locally and verify**

Run: `pnpm db:migrate`
Expected: migration applies cleanly. Then `pnpm typecheck` passes.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema/settings.ts server/db/schema/index.ts server/db/migrations
git commit -m "feat(db): settings table for the AI config registry"
```

---

### Task 2: Registry types

**Files:**
- Create: `server/lib/ai/registry/types.ts`

No test (pure type/constant declarations); consumed by every later task.

- [ ] **Step 1: Write the file**

```ts
// server/lib/ai/registry/types.ts
// Shared contracts for the AI config registry. The persisted document is one
// JSONB row (settings.key='ai_config'); ResolvedModel is the decrypted,
// ready-to-call shape the resolver hands to consumers.

export const USAGES = ['reasoning', 'bulk', 'embeddings', 'vision', 'stt', 'tts', 'rerank'] as const
export type Usage = (typeof USAGES)[number]

export const EMBEDDING_DIM = 2560

export type ProviderKind = 'anthropic' | 'openai-compatible'

export interface ProviderDef {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string | null      // required for openai-compatible; null for anthropic
  apiKeyEnc: string | null    // AES-GCM ciphertext; server-only, never serialized to client
}

export interface ModelDef {
  id: string
  providerId: string
  modelId: string             // literal string sent to the API
  label: string
  dim: number | null          // EMBEDDING_DIM for embedding models, else null
}

export type Assignments = Record<Usage, string[]>  // usage -> ordered model ids (failover priority)

export interface AiConfigDoc {
  version: 1
  providers: ProviderDef[]
  models: ModelDef[]
  assignments: Assignments
}

// A model resolved for use: provider + model merged, key decrypted.
export interface ResolvedModel {
  usage: Usage
  modelDefId: string
  providerKind: ProviderKind
  baseURL: string | null
  apiKey: string | null
  modelId: string
  label: string
  dim: number | null
}

export function emptyAssignments(): Assignments {
  return { reasoning: [], bulk: [], embeddings: [], vision: [], stt: [], tts: [], rerank: [] }
}

export function emptyDoc(): AiConfigDoc {
  return { version: 1, providers: [], models: [], assignments: emptyAssignments() }
}
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add server/lib/ai/registry/types.ts
git commit -m "feat(ai): registry types (config doc, usages, resolved model)"
```

---

### Task 3: Crypto (AES-256-GCM, key from BETTER_AUTH_SECRET)

**Files:**
- Create: `server/lib/ai/registry/crypto.ts`
- Test: `test/ai-registry-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ai-registry-crypto.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '../server/lib/ai/registry/crypto'

beforeAll(() => { process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789' })

describe('registry crypto', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('sk-ant-abc123')
    expect(enc).not.toContain('sk-ant')           // ciphertext, not plaintext
    expect(decryptSecret(enc)).toBe('sk-ant-abc123')
  })

  it('produces different ciphertext each call (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('throws on a tampered ciphertext (auth tag)', () => {
    const enc = encryptSecret('secret')
    const bytes = Buffer.from(enc, 'base64'); bytes[bytes.length - 1] ^= 0xff
    expect(() => decryptSecret(bytes.toString('base64'))).toThrow()
  })

  it('CONFIG_ENC_KEY overrides the derived key', () => {
    const prev = process.env.CONFIG_ENC_KEY
    process.env.CONFIG_ENC_KEY = Buffer.alloc(32, 7).toString('base64')
    const enc = encryptSecret('x')
    expect(decryptSecret(enc)).toBe('x')
    process.env.CONFIG_ENC_KEY = prev
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/ai-registry-crypto.test.ts`
Expected: FAIL — `Cannot find module '.../crypto'`

- [ ] **Step 3: Implement**

```ts
// server/lib/ai/registry/crypto.ts
// AES-256-GCM for provider API keys. The key is derived from BETTER_AUTH_SECRET
// via HKDF-SHA256 (so no new required env), or taken from CONFIG_ENC_KEY
// (raw 32-byte base64) when set. Stored format: base64(iv(12) | tag(16) | ct).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

function key(): Buffer {
  const override = process.env.CONFIG_ENC_KEY
  if (override) {
    const raw = Buffer.from(override, 'base64')
    if (raw.length !== 32) throw new Error('CONFIG_ENC_KEY must be 32 bytes (base64)')
    return raw
  }
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to encrypt AI config secrets')
  // HKDF → 32 bytes. Fixed salt/info: deterministic per BETTER_AUTH_SECRET.
  return Buffer.from(hkdfSync('sha256', secret, 'mymind-ai-config', 'ai-config-key', 32))
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/ai-registry-crypto.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/lib/ai/registry/crypto.ts test/ai-registry-crypto.test.ts
git commit -m "feat(ai): registry crypto (AES-256-GCM, HKDF key from auth secret)"
```

---

### Task 4: Zod schema, referential validation, redaction

**Files:**
- Create: `server/lib/ai/registry/schema.ts`
- Test: `test/ai-registry-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ai-registry-schema.test.ts
import { describe, it, expect } from 'vitest'
import { parseConfig, redactDoc } from '../server/lib/ai/registry/schema'
import { emptyDoc } from '../server/lib/ai/registry/types'

function doc() {
  return {
    version: 1 as const,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible' as const, baseURL: 'http://x/v1', apiKeyEnc: 'ENC' }],
    models: [{ id: 'm1', providerId: 'p1', modelId: 'qwen', label: 'Qwen', dim: null }],
    assignments: { ...emptyDoc().assignments, reasoning: ['m1'] }
  }
}

describe('config schema', () => {
  it('parses a valid document', () => {
    expect(parseConfig(doc()).assignments.reasoning).toEqual(['m1'])
  })

  it('rejects a model referencing a missing provider', () => {
    const d = doc(); d.models[0]!.providerId = 'nope'
    expect(() => parseConfig(d)).toThrow(/provider/i)
  })

  it('rejects an assignment referencing a missing model', () => {
    const d = doc(); d.assignments.reasoning = ['ghost']
    expect(() => parseConfig(d)).toThrow(/model/i)
  })

  it('rejects an openai-compatible provider with no baseURL', () => {
    const d = doc(); d.providers[0]!.baseURL = null
    expect(() => parseConfig(d)).toThrow(/baseURL/i)
  })

  it('redactDoc strips ciphertext and sets hasKey', () => {
    const r = redactDoc(parseConfig(doc()))
    const p = r.providers[0]! as Record<string, unknown>
    expect(p.apiKeyEnc).toBeUndefined()
    expect(p.hasKey).toBe(true)
  })
}) 
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/ai-registry-schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// server/lib/ai/registry/schema.ts
// Zod schema for the AI config document + referential integrity (no FKs since
// it's one JSONB doc) + a client-safe redaction that strips key ciphertext.
import { z } from 'zod'
import { USAGES, type AiConfigDoc, type Usage } from './types'

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['anthropic', 'openai-compatible']),
  baseURL: z.string().url().nullable(),
  apiKeyEnc: z.string().nullable()
})

const modelSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1),
  dim: z.number().int().positive().nullable()
})

const assignmentsSchema = z.object(
  Object.fromEntries(USAGES.map(u => [u, z.array(z.string())])) as Record<Usage, z.ZodArray<z.ZodString>>
)

const docSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerSchema),
  models: z.array(modelSchema),
  assignments: assignmentsSchema
}).superRefine((d, ctx) => {
  const providerIds = new Set(d.providers.map(p => p.id))
  const modelIds = new Set(d.models.map(m => m.id))
  for (const p of d.providers) {
    if (p.kind === 'openai-compatible' && !p.baseURL) {
      ctx.addIssue({ code: 'custom', message: `provider "${p.name}" (openai-compatible) requires a baseURL`, path: ['providers'] })
    }
  }
  for (const m of d.models) {
    if (!providerIds.has(m.providerId)) {
      ctx.addIssue({ code: 'custom', message: `model "${m.label}" references missing provider ${m.providerId}`, path: ['models'] })
    }
  }
  for (const u of USAGES) {
    for (const id of d.assignments[u]) {
      if (!modelIds.has(id)) {
        ctx.addIssue({ code: 'custom', message: `assignment "${u}" references missing model ${id}`, path: ['assignments', u] })
      }
    }
  }
})

export function parseConfig(input: unknown): AiConfigDoc {
  return docSchema.parse(input) as AiConfigDoc
}

export interface RedactedProvider { id: string; name: string; kind: string; baseURL: string | null; hasKey: boolean }
export interface RedactedDoc { version: 1; providers: RedactedProvider[]; models: AiConfigDoc['models']; assignments: AiConfigDoc['assignments'] }

/** Client-safe view: no ciphertext ever leaves the server. */
export function redactDoc(doc: AiConfigDoc): RedactedDoc {
  return {
    version: doc.version,
    providers: doc.providers.map(p => ({ id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, hasKey: p.apiKeyEnc !== null })),
    models: doc.models,
    assignments: doc.assignments
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/ai-registry-schema.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/lib/ai/registry/schema.ts test/ai-registry-schema.test.ts
git commit -m "feat(ai): registry config schema, referential validation, redaction"
```

---

### Task 5: Typed errors

**Files:**
- Create: `server/lib/ai/registry/errors.ts`

No standalone test (exercised in Task 6).

- [ ] **Step 1: Write the file**

```ts
// server/lib/ai/registry/errors.ts
import type { Usage } from './types'

export class AiNotConfiguredError extends Error {
  constructor(public usage: Usage) {
    super(`No model is configured for "${usage}". Configure it in Settings.`)
    this.name = 'AiNotConfiguredError'
  }
}

export class AiAllFailedError extends Error {
  constructor(public usage: Usage, public attempts: { label: string; error: string }[]) {
    super(`All ${attempts.length} model(s) for "${usage}" failed: ${attempts.map(a => `${a.label} (${a.error})`).join('; ')}`)
    this.name = 'AiAllFailedError'
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigValidationError' }
}
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add server/lib/ai/registry/errors.ts
git commit -m "feat(ai): registry typed errors"
```

---

### Task 6: Resolver — pure core (resolveChainFrom, withFailoverOver, languageModel)

**Files:**
- Create: `server/lib/ai/registry/resolve.ts`
- Test: `test/ai-registry-resolve.test.ts`

The pure functions take a doc/chain explicitly so they unit-test without a DB. Task 7 adds the cached async wrappers.

- [ ] **Step 1: Write the failing test**

```ts
// test/ai-registry-resolve.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { resolveChainFrom, withFailoverOver } from '../server/lib/ai/registry/resolve'
import { AiNotConfiguredError, AiAllFailedError } from '../server/lib/ai/registry/errors'
import { encryptSecret } from '../server/lib/ai/registry/crypto'
import { emptyDoc, EMBEDDING_DIM, type AiConfigDoc, type ResolvedModel } from '../server/lib/ai/registry/types'

beforeAll(() => { process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789' })

function build(): AiConfigDoc {
  return {
    version: 1,
    providers: [
      { id: 'p1', name: 'A', kind: 'openai-compatible', baseURL: 'http://a/v1', apiKeyEnc: encryptSecret('k1') },
      { id: 'p2', name: 'B', kind: 'anthropic', baseURL: null, apiKeyEnc: encryptSecret('k2') }
    ],
    models: [
      { id: 'm1', providerId: 'p1', modelId: 'qwen', label: 'Qwen', dim: null },
      { id: 'm2', providerId: 'p2', modelId: 'claude', label: 'Claude', dim: null },
      { id: 'e1', providerId: 'p1', modelId: 'embed', label: 'Embed', dim: EMBEDDING_DIM },
      { id: 'e2', providerId: 'p1', modelId: 'embed-bad', label: 'EmbedBad', dim: 1024 }
    ],
    assignments: { ...emptyDoc().assignments, reasoning: ['m1', 'm2'], embeddings: ['e2', 'e1'] }
  }
}

describe('resolveChainFrom', () => {
  it('returns the ordered, decrypted chain', () => {
    const chain = resolveChainFrom(build(), 'reasoning')
    expect(chain.map(m => m.modelId)).toEqual(['qwen', 'claude'])
    expect(chain[0]!.apiKey).toBe('k1')
    expect(chain[1]!.providerKind).toBe('anthropic')
  })

  it('throws AiNotConfiguredError for an empty usage', () => {
    expect(() => resolveChainFrom(build(), 'tts')).toThrow(AiNotConfiguredError)
  })

  it('filters the embeddings chain to dim-2560 models', () => {
    const chain = resolveChainFrom(build(), 'embeddings')
    expect(chain.map(m => m.modelId)).toEqual(['embed'])  // embed-bad (1024) dropped
  })
})

describe('withFailoverOver', () => {
  const chain: ResolvedModel[] = [
    { usage: 'bulk', modelDefId: 'm1', providerKind: 'openai-compatible', baseURL: 'http://a', apiKey: 'k', modelId: 'a', label: 'A', dim: null },
    { usage: 'bulk', modelDefId: 'm2', providerKind: 'openai-compatible', baseURL: 'http://b', apiKey: 'k', modelId: 'b', label: 'B', dim: null }
  ]

  it('uses the first model that succeeds', async () => {
    const used: string[] = []
    const out = await withFailoverOver('bulk', chain, async (m) => { used.push(m.modelId); return m.modelId.toUpperCase() })
    expect(out).toBe('A'); expect(used).toEqual(['a'])
  })

  it('falls over to the next on error', async () => {
    const out = await withFailoverOver('bulk', chain, async (m) => {
      if (m.modelId === 'a') throw new Error('down')
      return 'ok'
    })
    expect(out).toBe('ok')
  })

  it('throws AiAllFailedError when every model fails', async () => {
    await expect(withFailoverOver('bulk', chain, async () => { throw new Error('boom') }))
      .rejects.toBeInstanceOf(AiAllFailedError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/ai-registry-resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the pure core**

```ts
// server/lib/ai/registry/resolve.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { decryptSecret } from './crypto'
import { AiNotConfiguredError, AiAllFailedError } from './errors'
import { EMBEDDING_DIM, type AiConfigDoc, type ResolvedModel, type Usage } from './types'

/** Pure: build the ordered, decrypted chain for a usage from a config doc. */
export function resolveChainFrom(doc: AiConfigDoc, usage: Usage): ResolvedModel[] {
  const ids = doc.assignments[usage] ?? []
  const providers = new Map(doc.providers.map(p => [p.id, p]))
  let chain: ResolvedModel[] = []
  for (const id of ids) {
    const m = doc.models.find(x => x.id === id)
    if (!m) continue
    const p = providers.get(m.providerId)
    if (!p) continue
    let apiKey: string | null = null
    if (p.apiKeyEnc) { try { apiKey = decryptSecret(p.apiKeyEnc) } catch { apiKey = null } }
    chain.push({
      usage, modelDefId: m.id, providerKind: p.kind, baseURL: p.baseURL,
      apiKey, modelId: m.modelId, label: m.label, dim: m.dim
    })
  }
  // Embeddings can't fail over to a different dimension — keep only 2560.
  if (usage === 'embeddings') chain = chain.filter(m => m.dim === EMBEDDING_DIM)
  if (chain.length === 0) throw new AiNotConfiguredError(usage)
  return chain
}

/** Pure: run fn against each model in order until one succeeds. */
export async function withFailoverOver<T>(usage: Usage, chain: ResolvedModel[], fn: (m: ResolvedModel) => Promise<T>): Promise<T> {
  const attempts: { label: string; error: string }[] = []
  for (const m of chain) {
    try { return await fn(m) }
    catch (err) { attempts.push({ label: m.label, error: (err as Error).message }) }
  }
  throw new AiAllFailedError(usage, attempts)
}

/** Build a kind-aware AI SDK language model (used by reasoning/bulk/vision LLM roles). */
export function languageModel(m: ResolvedModel): LanguageModel {
  if (m.providerKind === 'anthropic') {
    return createAnthropic({ apiKey: m.apiKey || undefined })(m.modelId)
  }
  return createOpenAICompatible({
    name: `mymind-${m.usage}`,
    baseURL: (m.baseURL ?? '').replace(/\/$/, ''),
    apiKey: m.apiKey || 'none'
  })(m.modelId)
}
```

- [ ] **Step 4: Add the dep and run**

Run: `pnpm add @ai-sdk/anthropic`
Then: `pnpm vitest run test/ai-registry-resolve.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/lib/ai/registry/resolve.ts test/ai-registry-resolve.test.ts package.json pnpm-lock.yaml
git commit -m "feat(ai): registry resolver core — chain resolution, failover, kind-aware model"
```

---

### Task 7: Store + cached resolver wrappers

**Files:**
- Modify: `server/lib/ai/registry/store.ts` (create)
- Modify: `server/lib/ai/registry/resolve.ts` (add cached async wrappers)

DB I/O — not unit-tested here (covered by the endpoint curl checks in Tasks 13–14 and Plan 2 E2E). Keep it thin.

- [ ] **Step 1: Create the store**

```ts
// server/lib/ai/registry/store.ts
// Thin DB I/O for the single ai_config JSONB row + an in-process cache.
// Single instance, so a module-level cache with explicit invalidation is enough.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { settings } from '../../../db/schema'
import { parseConfig } from './schema'
import { emptyDoc, type AiConfigDoc } from './types'

const KEY = 'ai_config'
let cache: AiConfigDoc | null = null

export async function loadConfig(): Promise<AiConfigDoc> {
  if (cache) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = row ? parseConfig(row.value) : emptyDoc()
  return cache
}

export async function saveConfig(doc: AiConfigDoc): Promise<void> {
  const validated = parseConfig(doc)  // re-validate before persisting
  const db = useDb()
  await db.insert(settings)
    .values({ key: KEY, value: validated, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: validated, updatedAt: new Date() } })
  cache = validated
}

export function invalidate(): void { cache = null }
```

- [ ] **Step 2: Add cached wrappers to `resolve.ts`**

Append to `server/lib/ai/registry/resolve.ts`:

```ts
import { loadConfig } from './store'

/** Cached: ordered decrypted chain for a usage (loads the doc once). */
export async function resolveChain(usage: Usage): Promise<ResolvedModel[]> {
  return resolveChainFrom(await loadConfig(), usage)
}

/** Cached: run fn against the usage's chain with failover. */
export async function withFailover<T>(usage: Usage, fn: (m: ResolvedModel) => Promise<T>): Promise<T> {
  return withFailoverOver(usage, await resolveChain(usage), fn)
}
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck passes; full suite still green (no behavior change to existing tests yet).

```bash
git add server/lib/ai/registry/store.ts server/lib/ai/registry/resolve.ts
git commit -m "feat(ai): registry store (JSONB row + cache) and cached resolver wrappers"
```

---

### Task 8: Refactor reasoning (model.ts + run.ts, start-only failover)

**Files:**
- Modify: `server/lib/agent/model.ts`
- Modify: `server/lib/agent/run.ts:35` (the `reasoningModel()` call)

- [ ] **Step 1: Rewrite `model.ts`**

Full replacement:

```ts
// server/lib/agent/model.ts
import type { LanguageModel } from 'ai'
import { resolveChain, languageModel } from '../ai/registry/resolve'

/**
 * Ordered AI SDK language models for the reasoning role (registry-configured).
 * runAgent tries them in order at stream start (start-only failover).
 */
export async function reasoningModels(): Promise<LanguageModel[]> {
  const chain = await resolveChain('reasoning')
  return chain.map(languageModel)
}
```

- [ ] **Step 2: Wire start-only failover in `run.ts`**

In `server/lib/agent/run.ts`, replace the model resolution + `streamText` call. Current:

```ts
  const model = deps.streamText ? (undefined as never) : reasoningModel()
  publishActivity({ type: 'state', state: 'thinking' })
  const result = (streamTextFn as unknown as typeof realStreamText)({
    model,
    system: buildSystemPrompt(ctx.voice ?? false),
    messages: messages.filter(m => m.role !== 'system'),
    tools,
    stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps),
    abortSignal: ctx.signal
  })
```

becomes:

```ts
  publishActivity({ type: 'state', state: 'thinking' })

  // Build the stream, trying each reasoning model in priority order. If stream
  // creation throws (bad baseURL, adapter construction), fall over to the next.
  // Mid-stream failures are NOT retried.
  const models = deps.streamText ? [undefined as never] : await reasoningModels()
  let result: ReturnType<typeof realStreamText> | undefined
  let lastErr: unknown
  for (const model of models) {
    try {
      result = (streamTextFn as unknown as typeof realStreamText)({
        model,
        system: buildSystemPrompt(ctx.voice ?? false),
        messages: messages.filter(m => m.role !== 'system'),
        tools,
        stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps),
        abortSignal: ctx.signal
      })
      break
    } catch (err) { lastErr = err }
  }
  if (!result) throw lastErr ?? new Error('no reasoning model available')
```

Replace `reasoningModel` import with `reasoningModels` at the top of `run.ts`:

```ts
import { reasoningModels } from './model'
```

> Note: `streamText` surfaces most provider errors inside the stream, not at the call. True start-failover would require pulling the first part; for v1 this catches synchronous/creation errors (bad baseURL, adapter construction). Document this limitation; deeper first-token failover is a follow-up.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: `test/run-agent.test.ts` (mock streamText) still passes — the injected `deps.streamText` path uses `[undefined]` and the loop runs once.

- [ ] **Step 4: Commit**

```bash
git add server/lib/agent/model.ts server/lib/agent/run.ts
git commit -m "feat(ai): reasoning resolves from registry with start-only failover"
```

---

### Task 9: Refactor embeddings

**Files:**
- Modify: `server/lib/ai/embeddings.ts:28-40` (the config read + fetch)

- [ ] **Step 1: Replace the config read inside `embed()`**

In `server/lib/ai/embeddings.ts`, the body currently reads:

```ts
  const cfg = useRuntimeConfig().ai.embeddings as { baseURL?: string; apiKey?: string }
  if (!cfg.baseURL) {
    throw new Error('embeddings not configured (AI_EMBEDDINGS_BASE_URL)')
  }

  const raw = await $fetch(`${cfg.baseURL.replace(/\/$/, '')}/embed`, {
    method: 'POST',
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
    body: { inputs: texts, normalize: true }
  })

  const vectors = normalizeResponse(raw)
```

Replace with a failover call (TEI request shape preserved):

```ts
  const vectors = await withFailover('embeddings', async (m) => {
    const raw = await $fetch(`${(m.baseURL ?? '').replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined,
      body: { inputs: texts, normalize: true }
    })
    return normalizeResponse(raw)
  })
```

Add the import at the top:

```ts
import { withFailover } from '../registry/resolve' // adjust relative path: from server/lib/ai/embeddings.ts → './registry/resolve'
```

(Correct path from `server/lib/ai/embeddings.ts` is `./registry/resolve`.)

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add server/lib/ai/embeddings.ts
git commit -m "feat(ai): embeddings config from registry (failover, dim-gated)"
```

---

### Task 10: Refactor chat (bulk) + vision

**Files:**
- Modify: `server/lib/ai/chat.ts`
- Modify: `server/lib/ai/vision.ts`

Both are OpenAI-spec `/chat/completions` callers. Keep that request shape; source `{baseURL, apiKey, modelId}` from the resolver with failover. (Anthropic `kind` for these roles is a documented v-next; v1 assumes openai-compatible endpoints for bulk/vision.)

- [ ] **Step 1: Rewrite `chat.ts`**

Full replacement:

```ts
// server/lib/ai/chat.ts
import { withFailover } from './registry/resolve'
import type { Usage } from './registry/types'

export interface TextPart { type: 'text', text: string }
export interface ImageUrlPart { type: 'image_url', image_url: { url: string } }
export type ContentPart = TextPart | ImageUrlPart

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

// `role` here is a registry Usage (e.g. 'bulk', 'vision').
export async function chat(
  role: Usage,
  messages: ChatMessage[],
  opts: { temperature?: number, maxTokens?: number } = {}
): Promise<string> {
  return withFailover(role, async (m) => {
    const res = await $fetch<{ choices: { message: { content: string } }[] }>(
      `${(m.baseURL ?? '').replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined,
        signal: AbortSignal.timeout(60000),
        body: { model: m.modelId, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 600 }
      }
    )
    return res.choices?.[0]?.message?.content ?? ''
  })
}
```

> If `chat()` callers import `AiRole` from `./provider`, update them to import `Usage` from `./registry/types`. Find them: `grep -rn "from './provider'\|from '../ai/provider'" server/`.

- [ ] **Step 2: Update `vision.ts`** — replace the `aiProvider('vision')` block + `$fetch`:

Current:
```ts
    const cfg = aiProvider('vision', { required: true })
    const messages = [ /* ... */ ]
    const res = await $fetch<{ choices: { message: { content: string } }[] }>(
      `${cfg.baseURL!.replace(/\/$/, '')}/chat/completions`,
      { method: 'POST', headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
        signal: AbortSignal.timeout(60000),
        body: { model: cfg.model, messages, temperature: 0.1, max_tokens: 600 } }
    )
    const raw = res.choices?.[0]?.message?.content ?? ''
```

becomes (reuse `chat()`):
```ts
    const messages = [ /* unchanged image_url message array */ ]
    const raw = await chat('vision', messages as ChatMessage[], { temperature: 0.1, maxTokens: 600 })
```

Replace the import `import { aiProvider } from './provider'` with `import { chat, type ChatMessage } from './chat'`. Keep the surrounding `try/catch` returning `empty` — failover errors are caught there, so vision still degrades gracefully.

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

```bash
git add server/lib/ai/chat.ts server/lib/ai/vision.ts
git commit -m "feat(ai): bulk chat + vision config from registry (failover)"
```

---

### Task 11: Refactor voice providers (stt/tts) + voices endpoint

**Files:**
- Modify: `server/lib/voice/providers/index.ts`
- Modify: `server/api/voice/ws.ts`
- Modify: `server/api/voice/voices.get.ts`

- [ ] **Step 1: Rewrite `providers/index.ts`** to take resolved models

Full replacement:

```ts
// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import { openAiTts } from './tts-openai'
import type { SttProvider, TtsProvider } from './types'
import type { ResolvedModel } from '../../ai/registry/types'

export function sttFromModel(m: ResolvedModel): SttProvider {
  return whisperStt({ baseURL: (m.baseURL ?? '').replace(/\/$/, ''), model: m.modelId, apiKey: m.apiKey ?? undefined })
}
export function ttsFromModel(m: ResolvedModel): TtsProvider {
  return openAiTts({ baseURL: (m.baseURL ?? '').replace(/\/$/, ''), model: m.modelId, apiKey: m.apiKey ?? undefined })
}
```

(`makeStt`, `makeTts`, `defaultVoice`, `TtsName` are deleted — voice no longer keys off a provider name.)

- [ ] **Step 2: Update `ws.ts`** — resolve chains and pass providers via failover

In `server/api/voice/ws.ts`: remove `import { makeStt, makeTts, defaultVoice, type TtsName }` and `VOICE_TUNING`'s provider default usage. The orchestrator deps `stt`/`tts` must become failover-aware. Simplest: resolve the **primary** stt/tts at call time and wrap the synthesize/transcribe in registry failover.

Replace the `ConnState` provider/voice fields and the turn construction:

```ts
import { withFailover } from '../../lib/ai/registry/resolve'
import { sttFromModel, ttsFromModel } from '../../lib/voice/providers'
// ConnState: drop `provider: TtsName`; keep `voice: string` (the runtime voice pick)
```

Build STT/TTS provider objects that fail over internally:

```ts
const stt = { transcribe: (audio: Uint8Array, o: { language?: string; signal: AbortSignal }) =>
  withFailover('stt', m => sttFromModel(m).transcribe(audio, o)) }
const tts = { synthesize: (text: string, o: { voice: string; signal: AbortSignal }) =>
  // async generator over the failover-selected provider
  ttsSynthFailover(text, o) }

async function* ttsSynthFailover(text: string, o: { voice: string; signal: AbortSignal }) {
  const provider = await withFailover('tts', async (m) => ttsFromModel(m)) // first reachable provider
  yield* provider.synthesize(text, o)
}
```

> The voice `{type:'voice'}` control message previously switched `provider`/`voice`; now it only sets `voice` (the runtime voice string). Update that branch to `s.voice = msg.voice` and drop provider switching. Confirm `SttProvider.transcribe` / `TtsProvider.synthesize` signatures in `providers/types.ts` and match them exactly.

- [ ] **Step 3: Update `voices.get.ts`** — list voices for resolved tts providers

```ts
// server/api/voice/voices.get.ts
import { resolveChain } from '../../lib/ai/registry/resolve'
export default defineEventHandler(async () => {
  const out: { provider: string, voice: string }[] = []
  let chain
  try { chain = await resolveChain('tts') } catch { return { voices: [] } }
  for (const m of chain) {
    const base = (m.baseURL ?? '').replace(/\/$/, '')
    try {
      const data = await $fetch<{ voices?: string[] }>(`${base}/audio/voices`,
        { headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined })
      for (const voice of data?.voices ?? []) if (typeof voice === 'string') out.push({ provider: m.label, voice })
    } catch { /* provider down — skip */ }
  }
  return { voices: out }
})
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck && pnpm test`
Expected: `test/orchestrator.test.ts` still passes (it injects `stt`/`tts` deps directly, bypassing the resolver).

```bash
git add server/lib/voice/providers/index.ts server/api/voice/ws.ts server/api/voice/voices.get.ts
git commit -m "feat(voice): stt/tts config from registry (failover); voice msg sets voice only"
```

---

### Task 12: Refactor rerank + delete the env path

**Files:**
- Modify: `server/services/memory.ts` (or wherever `rerank()` is called — `grep -rn "rerank(" server/services server/lib`)
- Delete: `server/lib/ai/provider.ts`
- Modify: `nuxt.config.ts` (remove the `ai:` runtimeConfig block)
- Modify: `docker-compose.prod.yml` (remove the 25 `NUXT_AI_*` lines)
- Modify: `.env.example` (remove the `AI_*` block; add a `CONFIG_ENC_KEY` note)

- [ ] **Step 1: Resolve rerank config at the call site**

Find the caller (`grep -rn "rerank(" server/`). It currently passes `baseUrl`/`apiKey` from runtimeConfig. Replace with a resolver lookup that no-ops when unconfigured (rerank is optional):

```ts
import { resolveChain } from '../lib/ai/registry/resolve'
import { rerank } from '../lib/ai/rerank'
// ...
let rerankCfg: { baseURL: string; apiKey: string } | null = null
try {
  const [m] = await resolveChain('rerank')
  if (m?.baseURL) rerankCfg = { baseURL: m.baseURL.replace(/\/$/, ''), apiKey: m.apiKey ?? '' }
} catch { rerankCfg = null }  // AiNotConfiguredError → rerank stays off
// then: if (rerankCfg) results = await rerank(query, docs, rerankCfg.baseURL, rerankCfg.apiKey)
```

Keep `rerank()`'s `(query, docs, baseUrl, apiKey)` signature unchanged.

- [ ] **Step 2: Delete `provider.ts`**

```bash
git rm server/lib/ai/provider.ts
```
Then `grep -rn "ai/provider\|aiProvider\|AiRole" server/` — fix any remaining imports (should be none after Tasks 8–11).

- [ ] **Step 3: Remove the `ai:` block from `nuxt.config.ts`**

Delete the entire `ai: { reasoning: …, bulk: …, …, rerankBaseUrl, rerankApiKey }` object from `runtimeConfig` (lines ~79–93). Keep everything else.

- [ ] **Step 4: Remove the `NUXT_AI_*` mappings from `docker-compose.prod.yml`**

Delete the 25 `NUXT_AI_*: ${AI_*:-}` lines added in the prod-env fix (keep the `DATABASE_URL`, `STORAGE_*`, `NITRO_*` lines and the comment about runtimeConfig prefixing — reword the comment to note AI config now lives in the DB).

- [ ] **Step 5: Trim `.env.example`**

Remove the `AI_REASONING_* / AI_BULK_* / AI_EMBEDDINGS_* / AI_VISION_* / AI_STT_* / AI_TTS_* / AI_RERANK_*` block. Add:

```bash
# AI providers/models are configured in the app at /settings (stored encrypted in the DB).
# Optional: a 32-byte base64 key to encrypt provider API keys. If unset, a key is
# derived from BETTER_AUTH_SECRET. Set this only if you want key rotation independent of auth.
# CONFIG_ENC_KEY=
```

- [ ] **Step 6: Verify + commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green. (`build` confirms no stale `runtimeConfig.ai` references remain.)

```bash
git add -A
git commit -m "refactor(ai): remove env-based AI config (provider.ts, runtimeConfig.ai, NUXT_AI_* mappings, .env AI block)"
```

---

### Task 13: GET + PUT endpoints

**Files:**
- Create: `server/api/settings/ai-config.get.ts`
- Create: `server/api/settings/ai-config.put.ts`

Auth: `/api/*` is already session-gated by `server/middleware/auth.ts`. No extra check needed.

- [ ] **Step 1: GET (redacted)**

```ts
// server/api/settings/ai-config.get.ts
import { loadConfig } from '../../lib/ai/registry/store'
import { redactDoc } from '../../lib/ai/registry/schema'

export default defineEventHandler(async () => {
  return redactDoc(await loadConfig())
})
```

- [ ] **Step 2: PUT (validate, encrypt new keys, dim-probe, save, invalidate)**

The client sends the full doc with each provider's key as one of: `{ apiKey: '<plaintext>' }` (new/replaced), `{ keep: true }` (retain existing), or `null` (clear). Models/assignments come as-is.

```ts
// server/api/settings/ai-config.put.ts
import { z } from 'zod'
import { loadConfig, saveConfig, invalidate } from '../../lib/ai/registry/store'
import { parseConfig } from '../../lib/ai/registry/schema'
import { encryptSecret } from '../../lib/ai/registry/crypto'
import { resolveChainFrom } from '../../lib/ai/registry/resolve'
import { EMBEDDING_DIM, USAGES, type AiConfigDoc } from '../../lib/ai/registry/types'

const KeyField = z.union([z.object({ apiKey: z.string().min(1) }), z.object({ keep: z.literal(true) }), z.null()])
const Body = z.object({
  version: z.literal(1),
  providers: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.enum(['anthropic', 'openai-compatible']),
    baseURL: z.string().url().nullable(), key: KeyField
  })),
  models: z.array(z.object({ id: z.string(), providerId: z.string(), modelId: z.string(), label: z.string(), dim: z.number().int().positive().nullable() })),
  assignments: z.object(Object.fromEntries(USAGES.map(u => [u, z.array(z.string())])))
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const existing = await loadConfig()
  const prevKey = new Map(existing.providers.map(p => [p.id, p.apiKeyEnc]))

  // Resolve each provider's apiKeyEnc from the key field.
  const providers = body.providers.map((p) => {
    let apiKeyEnc: string | null = null
    if (p.key && 'apiKey' in p.key) apiKeyEnc = encryptSecret(p.key.apiKey)
    else if (p.key && 'keep' in p.key) apiKeyEnc = prevKey.get(p.id) ?? null
    else apiKeyEnc = null
    return { id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, apiKeyEnc }
  })

  let doc: AiConfigDoc
  try {
    doc = parseConfig({ version: 1, providers, models: body.models, assignments: body.assignments })
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: 'Invalid config', data: (err as Error).message })
  }

  // Embeddings dim probe: the primary embedding model must produce EMBEDDING_DIM vectors.
  if (doc.assignments.embeddings.length) {
    const [m] = resolveChainFrom(doc, 'embeddings')
    try {
      const raw = await $fetch<unknown>(`${(m!.baseURL ?? '').replace(/\/$/, '')}/embed`, {
        method: 'POST', headers: m!.apiKey ? { authorization: `Bearer ${m!.apiKey}` } : undefined,
        body: { inputs: ['probe'], normalize: true }, signal: AbortSignal.timeout(15000)
      })
      const v = Array.isArray(raw) ? (raw as number[][])[0] : ((raw as { embeddings?: number[][] }).embeddings ?? (raw as { data?: number[][] }).data)?.[0]
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
        throw createError({ statusCode: 422, statusMessage: `Embedding model returned ${Array.isArray(v) ? v.length : '?'} dims, expected ${EMBEDDING_DIM}` })
      }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 422) throw err
      throw createError({ statusCode: 422, statusMessage: 'Embedding probe failed (model unreachable?)', data: (err as Error).message })
    }
  }

  await saveConfig(doc)
  invalidate()
  return { ok: true }
})
```

- [ ] **Step 3: Verify (typecheck + manual curl)**

Run: `pnpm typecheck`
Then with `pnpm dev` running and a logged-in cookie, `PUT /api/settings/ai-config` a minimal doc (no embeddings to skip the probe) and `GET` it back — confirm `hasKey:true`, no ciphertext.

- [ ] **Step 4: Commit**

```bash
git add server/api/settings/ai-config.get.ts server/api/settings/ai-config.put.ts
git commit -m "feat(api): GET/PUT /api/settings/ai-config (redacted read, encrypted write, dim probe)"
```

---

### Task 14: test-provider endpoint

**Files:**
- Create: `server/api/settings/test-provider.post.ts`

- [ ] **Step 1: Implement**

```ts
// server/api/settings/test-provider.post.ts
// Ping a provider to confirm it's reachable + auth works. Inline config (a
// not-yet-saved provider from the form) or {keep:true} to reuse a stored key.
import { z } from 'zod'
import { loadConfig } from '../../lib/ai/registry/store'
import { decryptSecret } from '../../lib/ai/registry/crypto'

const Body = z.object({
  id: z.string().optional(),
  kind: z.enum(['anthropic', 'openai-compatible']),
  baseURL: z.string().url().nullable(),
  apiKey: z.string().nullable()   // plaintext from the form, or null to reuse stored key by id
})

export default defineEventHandler(async (event) => {
  const b = Body.parse(await readBody(event))
  let apiKey = b.apiKey ?? ''
  if (!apiKey && b.id) {
    const cfg = await loadConfig()
    const enc = cfg.providers.find(p => p.id === b.id)?.apiKeyEnc
    if (enc) { try { apiKey = decryptSecret(enc) } catch { /* leave empty */ } }
  }
  try {
    if (b.kind === 'anthropic') {
      const res = await $fetch.raw('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000)
      })
      return { ok: res.status < 400, message: `HTTP ${res.status}` }
    }
    const res = await $fetch.raw(`${(b.baseURL ?? '').replace(/\/$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined, signal: AbortSignal.timeout(10000)
    })
    return { ok: res.status < 400, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
})
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

```bash
git add server/api/settings/test-provider.post.ts
git commit -m "feat(api): POST /api/settings/test-provider (reachability + auth check)"
```

---

## Self-Review Notes

- **Spec coverage:** §3 doc shape → Tasks 2,4. §4 resolver/failover/languageModel + consumer refactor → Tasks 6–12. §4 deletions (`runtimeConfig.ai`, `aiProvider`, `NUXT_AI_*`, `.env` AI block) → Task 12. §5 endpoints → Tasks 13–14. §7 typed errors → Task 5. §8 unit tests → Tasks 3,4,6. **§6 (UI + onboarding) is Plan 2** — explicitly deferred. The Drizzle migration (§8) → Task 1.
- **Type consistency:** `Usage`/`ResolvedModel`/`AiConfigDoc`/`emptyDoc`/`EMBEDDING_DIM` defined in Task 2 and used verbatim in 4,6,7,11,13. `resolveChainFrom`/`withFailoverOver`/`languageModel` (pure, Task 6) vs `resolveChain`/`withFailover` (cached, Task 7) — names distinct and used consistently. `parseConfig`/`redactDoc` (Task 4) used in 7,13. `encryptSecret`/`decryptSecret` (Task 3) used in 6,13,14.
- **Known judgment calls:** start-only reasoning failover catches creation errors, not mid-stream (documented in Task 8). bulk/vision assume openai-compatible endpoints in v1 (anthropic kind is wired for reasoning only). The TTS failover picks the first reachable provider per turn (Task 11) rather than per-chunk. embeddings dim probe uses the TEI `/embed` shape matching `embeddings.ts`.
- **Deploy safety reminder:** feature branch only; do not merge until Plan 2 onboarding exists.
