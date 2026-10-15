# Artifacts Implementation Plan (cycle 86)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridget publishes static HTML pages / built webapps as versioned, public-or-private artifacts served sandboxed at `https://brain.costanzoclan.com/artifact/<slug>/`.

**Architecture:** Bundles are stored as content-addressed blobs (existing storage driver) with a per-version manifest (`path → {key, sha256, size, contentType}`) in Postgres. A Nitro server route outside `/api` serves manifest paths with a `CSP: sandbox` header (opaque origin — no cookie/session/`/api` access); private artifacts are reached via a short-lived HMAC path token minted after a session check. Agent tools in a new `artifacts` toolset call one service module; the web UI is a live vue-query resource with a list page, a detail page and an in-chat card.

**Tech Stack:** Nuxt 4 / Nitro (h3), drizzle-orm + Postgres, vitest, Nuxt UI v4, @tanstack/vue-query, playwright-cli, Python 3 scripts run inside the sandbox container.

**Spec:** `docs/superpowers/specs/2026-10-15-artifacts-design.md` — read it before any task.

## Global Constraints

- Work in the worktree `/Users/tony/Documents/GitHub/mymind/.claude/worktrees/artifacts` on branch `feat/artifacts`. Never `cd` to the main checkout. Never `git stash`.
- `pnpm` only. Gates: `pnpm typecheck`, `pnpm vitest run`, `pnpm build`. Lint is red repo-wide and is NOT a gate. DB tests are `*.db.test.ts`, run with `pnpm test:db <file>` (needs the local dev Postgres; `.env` in the worktree — copy it from the main checkout if missing).
- Commit messages: conventional (`feat(artifacts): …`). NO co-author lines, NO model names in commit messages.
- Limits (verbatim from spec): 25 MB total per version, 500 files, 10 MB per file.
- Slug regex: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.
- Artifact CSP (every artifact response, incl. 404/redirects): `sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`.
- Private token TTL 12 h; HMAC-SHA256 keyed from `BETTER_AUTH_SECRET` domain-separated with `"artifact-view:v1"`.
- Private: `Cache-Control: private, no-store`. Public: `Cache-Control: public, max-age=60`.
- Private by default (`is_public default false`). `data/`-only changes patch the current version in place; anything else is a new version.
- Inside `packages/core/src/**` use relative imports; from `server/**` and `app/**` import `@mymind/core/...`.
- Any timestamp shown to Tony uses the app's existing date formatting (prod is UTC — never `toLocaleString` without the agent timezone helper used elsewhere in `app/`).
- Browser validation uses `playwright-cli` (see `.claude/skills/browser-testing/SKILL.md`), never the MCP browser.

## Review Focus

1. **Secrets in a bundle** — a Vite build inlines `import.meta.env` values; publishing it publicly must not leak an opted-in secret. Expected: text files (html/js/mjs/css/json/map/txt/csv/svg) are masked with the sandbox secret masker before storage; an unreadable secret store refuses the publish. Pinned in Task 6.
2. **Vite's default `base: '/'`** — `dist/index.html` references `/assets/x.js`, which 404s under `/artifact/<slug>/`. Expected: the publish succeeds but the tool result carries a `warnings[]` line telling Bridget to rebuild with `base: './'`. Pinned in Task 7.
3. **Percent-encoded / odd request paths** (`my%20chart.png`, `%2e%2e/`, `a//b`, `?v=2`) — expected: decoded once, normalised, looked up; traversal still impossible; query ignored. Pinned in Task 2.
4. **Concurrent publishes to one slug** (a data-refresh job firing while Bridget republishes) — expected: both succeed with distinct version numbers (or one in place), no unique-violation error surfaced to the model. Pinned in Task 4.
5. **Slug reuse after delete** — expected: a soft-deleted artifact's slug can be published again as a brand-new artifact, and the URL serves the new one. Pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/db/schema/artifacts.ts` (create) | `artifacts`, `artifact_versions` tables + types |
| `packages/core/src/db/schema/index.ts` (modify) | export the new schema |
| `server/db/migrations/0089_*.sql` (generated) | migration |
| `packages/core/src/lib/artifacts/limits.ts` (create) | limits, content types, path normalisation, slug rules, `ArtifactError` |
| `packages/core/src/lib/artifacts/manifest.ts` (create) | pure manifest ops: lookup/SPA fallback, merge, data-only diff, validation |
| `packages/core/src/lib/artifacts/token.ts` (create) | sign/verify private view tokens |
| `packages/core/src/lib/artifacts/serve.ts` (create) | pure URL parse + request decision (redirect/serve/404/403) + headers |
| `packages/core/src/lib/artifacts/service.ts` (create) | all DB/storage writes and reads |
| `packages/core/src/lib/artifacts/workspace-bundle.ts` (create) | read a workspace directory into `files` (sandbox scripts, limits, masking) |
| `packages/core/src/lib/artifacts/html-warnings.ts` (create) | detect root-absolute asset refs in the entry HTML |
| `packages/core/src/shared/types/artifacts.ts` (create) | DTOs shared with the app |
| `packages/core/src/shared/types/live.ts` (modify) | add `'artifact'` to `ResourceName` |
| `server/routes/artifact/[...rest].ts` (create) | the serving route (IO only; logic in `serve.ts`) |
| `packages/core/src/lib/agent/tools/artifacts.ts` (create) | 4 agent tools |
| `packages/core/src/lib/agent/types.ts`, `ai-tools.ts`, `judge/rules.ts`, `eval/approval-tools.ts`, `toolsets.ts`, `tools.ts` (modify) | `outboundWhen`, toolset, registration |
| `server/api/artifacts/*` (create) | list/detail/patch/delete/view-url |
| `app/composables/useArtifacts.ts` (create) | vue-query hooks |
| `app/lib/artifacts/display.ts` (create) | pure helpers for the chat card + list formatting |
| `app/pages/artifacts/index.vue`, `app/pages/artifacts/[id].vue` (create) | list + detail pages |
| `app/components/artifacts/Frame.vue`, `ChatCard.vue` (create) | sandboxed iframe, chat card |
| `app/components/agent/ToolPart.vue`, `app/layouts/default.vue` (modify) | card hook-in, nav entry |
| `evals/bridget-core.json` (modify) | eval case |
| `docs/wiki/artifacts.md`, `docs/handovers/2026-10-15-artifacts.md`, roadmap, BACKLOG (create/modify) | docs |

---

### Task 1: Schema, limits and path rules

**Files:**
- Create: `packages/core/src/db/schema/artifacts.ts`
- Modify: `packages/core/src/db/schema/index.ts`
- Create: `packages/core/src/lib/artifacts/limits.ts`
- Test: `packages/core/src/lib/artifacts/limits.test.ts`
- Generated: `server/db/migrations/0089_*.sql` (+ `meta/` snapshot)

**Interfaces:**
- Produces:
  - tables `artifacts`, `artifactVersions`; types `Artifact`, `NewArtifact`, `ArtifactVersion`, `NewArtifactVersion`
  - `ManifestEntry = { key: string; sha256: string; size: number; contentType: string }`, `Manifest = Record<string, ManifestEntry>` (exported from `limits.ts`)
  - `ARTIFACT_MAX_TOTAL_BYTES`, `ARTIFACT_MAX_FILES`, `ARTIFACT_MAX_FILE_BYTES`
  - `class ArtifactError extends Error { code: 'bad_path' | 'bad_type' | 'too_large' | 'too_many' | 'no_entry' | 'bad_slug' | 'not_found' }`
  - `normalizeArtifactPath(p: string): string` (throws `ArtifactError('bad_path')`)
  - `contentTypeFor(path: string): string | null`, `isTextPath(path: string): boolean`
  - `SLUG_RE`, `slugProblem(s: string): string | null`, `slugFromTitle(title: string): string`

- [ ] **Step 1: Write the failing tests** — `limits.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { normalizeArtifactPath, contentTypeFor, isTextPath, slugProblem, slugFromTitle, ArtifactError } from './limits'

describe('normalizeArtifactPath', () => {
  it.each([
    ['index.html', 'index.html'],
    ['./assets/app.js', 'assets/app.js'],
    ['assets//app.js', 'assets/app.js'],
    ['data/x.json', 'data/x.json']
  ])('%s → %s', (input, out) => expect(normalizeArtifactPath(input)).toBe(out))

  it.each(['', '/etc/passwd', '../x', 'a/../../x', 'a/..', 'a\\b.js', 'a\0b', '.', 'dir/'])(
    'rejects %j', (p) => {
      expect(() => normalizeArtifactPath(p)).toThrow(ArtifactError)
    })
})

describe('contentTypeFor', () => {
  it('maps allowlisted extensions case-insensitively', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('A/B.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('x.wasm')).toBe('application/wasm')
    expect(contentTypeFor('font.woff2')).toBe('font/woff2')
  })
  it('returns null for anything else', () => {
    expect(contentTypeFor('video.mov')).toBeNull()
    expect(contentTypeFor('Makefile')).toBeNull()
    expect(contentTypeFor('x.exe')).toBeNull()
  })
})

describe('isTextPath', () => {
  it('is true for maskable text types only', () => {
    expect(isTextPath('a.js')).toBe(true)
    expect(isTextPath('a.svg')).toBe(true)
    expect(isTextPath('a.png')).toBe(false)
  })
})

describe('slugs', () => {
  it('accepts valid slugs', () => expect(slugProblem('sales-q3')).toBeNull())
  it.each(['', '-a', 'a-', 'A', 'a_b', 'x'.repeat(65)])('rejects %j', s => expect(slugProblem(s)).not.toBeNull())
  it('derives from a title', () => {
    expect(slugFromTitle('Q3 Sales — Dashboard!')).toBe('q3-sales-dashboard')
    expect(slugFromTitle('!!!')).toBe('artifact')
    expect(slugFromTitle('x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
})
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/lib/artifacts/limits.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `limits.ts`**

```ts
// Cycle 86 (spec §3): artifact limits, the content-type allowlist and path/slug rules — pure.
export const ARTIFACT_MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const ARTIFACT_MAX_FILES = 500
export const ARTIFACT_MAX_FILE_BYTES = 10 * 1024 * 1024

export type ManifestEntry = { key: string; sha256: string; size: number; contentType: string }
export type Manifest = Record<string, ManifestEntry>

export class ArtifactError extends Error {
  override name = 'ArtifactError'
  constructor(message: string, readonly code: 'bad_path' | 'bad_type' | 'too_large' | 'too_many' | 'no_entry' | 'bad_slug' | 'not_found') { super(message) }
}

const TEXT = '; charset=utf-8'
const TYPES: Record<string, string> = {
  html: 'text/html' + TEXT, htm: 'text/html' + TEXT, js: 'text/javascript' + TEXT, mjs: 'text/javascript' + TEXT,
  css: 'text/css' + TEXT, json: 'application/json' + TEXT, map: 'application/json' + TEXT, txt: 'text/plain' + TEXT,
  csv: 'text/csv' + TEXT, svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm'
}
const TEXT_EXTS = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'csv', 'svg'])

const ext = (p: string) => { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1]!.toLowerCase() : '' }
export function contentTypeFor(path: string): string | null { return TYPES[ext(path)] ?? null }
export function isTextPath(path: string): boolean { return TEXT_EXTS.has(ext(path)) }

export function normalizeArtifactPath(p: string): string {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || p.endsWith('/'))
    throw new ArtifactError(`bad path ${JSON.stringify(p)}: must be a relative file path`, 'bad_path')
  const parts = p.split('/').filter(s => s !== '' && s !== '.')
  if (!parts.length || parts.some(s => s === '..'))
    throw new ArtifactError(`bad path ${JSON.stringify(p)}: no .. or empty segments`, 'bad_path')
  return parts.join('/')
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
export function slugProblem(s: string): string | null {
  return SLUG_RE.test(s) ? null : 'slug must be 1–64 chars of a-z, 0-9 and -, not starting or ending with -'
}
export function slugFromTitle(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
  return s || 'artifact'
}
```

- [ ] **Step 4: Run the test again** — Expected: PASS.

- [ ] **Step 5: Schema** — `packages/core/src/db/schema/artifacts.ts`

```ts
// Cycle 86 (spec §3): artifacts — Bridget's published static pages/webapps.
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex, index, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { conversations } from './conversations'
import type { Manifest } from '../../lib/artifacts/limits'

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  isPublic: boolean('is_public').notNull().default(false),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => artifactVersions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, t => ({
  slugLive: uniqueIndex('artifacts_slug_live_uidx').on(t.slug).where(sql`deleted_at is null`),
  project: index('artifacts_project_idx').on(t.projectId)
}))

export const artifactVersions = pgTable('artifact_versions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  artifactId: uuid('artifact_id').notNull().references((): AnyPgColumn => artifacts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  manifest: jsonb('manifest').$type<Manifest>().notNull(),
  entry: text('entry').notNull().default('index.html'),
  spaFallback: boolean('spa_fallback').notNull().default(false),
  totalBytes: integer('total_bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => ({
  artifactVersion: uniqueIndex('artifact_versions_artifact_version_uidx').on(t.artifactId, t.version)
}))

export type Artifact = typeof artifacts.$inferSelect
export type NewArtifact = typeof artifacts.$inferInsert
export type ArtifactVersion = typeof artifactVersions.$inferSelect
export type NewArtifactVersion = typeof artifactVersions.$inferInsert
```

Match the existing schema files' style for the third `pgTable` argument (object vs array return) — check `images.ts` (object) and `agent-runs.ts` (array) and use whichever the repo's drizzle version prefers without deprecation warnings in `pnpm typecheck`. Add `export * from './artifacts'` to `packages/core/src/db/schema/index.ts`.

- [ ] **Step 6: Generate + apply the migration**

Run: `pnpm db:generate` → expect a new `server/db/migrations/0089_*.sql` creating both tables, the partial unique index and both FKs. Open it and check the partial index has `WHERE deleted_at is null`. Then `pnpm db:migrate` (local dev DB). Then `pnpm typecheck` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/db/schema/artifacts.ts packages/core/src/db/schema/index.ts packages/core/src/lib/artifacts/limits.ts packages/core/src/lib/artifacts/limits.test.ts server/db/migrations
git commit -m "feat(artifacts): schema, limits and path rules"
```

---

### Task 2: Manifest ops and the request decision (pure)

**Files:**
- Create: `packages/core/src/lib/artifacts/manifest.ts`, `packages/core/src/lib/artifacts/serve.ts`
- Test: `packages/core/src/lib/artifacts/manifest.test.ts`, `packages/core/src/lib/artifacts/serve.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `ManifestEntry`, `normalizeArtifactPath`, `ArtifactError`, limits (Task 1)
- Produces (`manifest.ts`):
  - `isDataPath(p: string): boolean` — `p.startsWith('data/')`
  - `mergeManifest(prev: Manifest | null, next: Manifest, merge: boolean): Manifest`
  - `onlyDataChanged(prev: Manifest, next: Manifest): boolean` — true iff every added/removed/changed (by sha256) path is a data path AND at least one path changed. Identical manifests → false.
  - `manifestStats(m: Manifest): { files: number; totalBytes: number }`
  - `validateManifest(m: Manifest, entry: string): void` — throws `ArtifactError` (`too_many`, `too_large`, `no_entry`)
  - `lookupPath(m: Manifest, entry: string, spaFallback: boolean, reqPath: string): { path: string; file: ManifestEntry } | null`
- Produces (`serve.ts`):
  - `parseArtifactUrl(pathname: string): { slug: string; token: string | null; path: string; trailingSlash: boolean } | null`
  - `type ServeDecision = { kind: 'redirect'; status: 301 | 302; location: string } | { kind: 'serve'; path: string; file: ManifestEntry; isPublic: boolean } | { kind: 'not_found' } | { kind: 'forbidden' }`
  - `decideArtifactRequest(i: DecideInput): ServeDecision` where `DecideInput = { pathname: string; search: string; found: { artifactId: string; slug: string; isPublic: boolean; manifest: Manifest; entry: string; spaFallback: boolean } | null; hasSession: boolean; tokenStatus: 'ok' | 'expired' | 'invalid' | 'absent'; isNavigation: boolean; mintToken: () => string }`
  - `artifactHeaders(isPublic: boolean): Record<string, string>` and const `ARTIFACT_CSP`

- [ ] **Step 1: Write failing tests** — `manifest.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mergeManifest, onlyDataChanged, validateManifest, lookupPath, manifestStats } from './manifest'
import { ArtifactError, type Manifest } from './limits'

const f = (sha: string, size = 10, contentType = 'text/html; charset=utf-8') => ({ key: `k/${sha}`, sha256: sha, size, contentType })
const base: Manifest = { 'index.html': f('a'), 'assets/app.js': f('b'), 'data/x.json': f('c') }

describe('mergeManifest', () => {
  it('replace mode returns next exactly', () => expect(mergeManifest(base, { 'index.html': f('z') }, false)).toEqual({ 'index.html': f('z') }))
  it('merge mode overlays', () => expect(mergeManifest(base, { 'data/x.json': f('d') }, true)).toEqual({ ...base, 'data/x.json': f('d') }))
  it('no previous → next', () => expect(mergeManifest(null, base, true)).toEqual(base))
})

describe('onlyDataChanged', () => {
  it('data change only → true', () => expect(onlyDataChanged(base, { ...base, 'data/x.json': f('d') })).toBe(true))
  it('new data file → true', () => expect(onlyDataChanged(base, { ...base, 'data/y.json': f('e') })).toBe(true))
  it('removing a data file → true', () => { const { 'data/x.json': _, ...rest } = base; expect(onlyDataChanged(base, rest)).toBe(true) })
  it('non-data change → false', () => expect(onlyDataChanged(base, { ...base, 'index.html': f('q'), 'data/x.json': f('d') })).toBe(false))
  it('identical → false', () => expect(onlyDataChanged(base, { ...base })).toBe(false))
  it('"database/x" is not a data path', () => expect(onlyDataChanged(base, { ...base, 'database/x.json': f('w') })).toBe(false))
})

describe('validateManifest', () => {
  it('passes a valid manifest', () => expect(() => validateManifest(base, 'index.html')).not.toThrow())
  it('missing entry', () => expect(() => validateManifest(base, 'main.html')).toThrow(/entry main.html not found/))
  it('too many files', () => {
    const m: Manifest = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.js`, f(String(i), 1)]))
    m['index.html'] = f('i')
    expect(() => validateManifest(m, 'index.html')).toThrow(ArtifactError)
  })
  it('too large in total', () => {
    const m: Manifest = { 'index.html': f('i'), 'a.png': f('p', 9 * 1024 * 1024), 'b.png': f('q', 9 * 1024 * 1024), 'c.png': f('r', 9 * 1024 * 1024) }
    expect(() => validateManifest(m, 'index.html')).toThrow(/25 MB/)
  })
  it('stats', () => expect(manifestStats(base)).toEqual({ files: 3, totalBytes: 30 }))
})

describe('lookupPath', () => {
  it('empty path → entry', () => expect(lookupPath(base, 'index.html', false, '')?.path).toBe('index.html'))
  it('exact hit', () => expect(lookupPath(base, 'index.html', false, 'assets/app.js')?.path).toBe('assets/app.js'))
  it('dir path with index.html inside', () => {
    const m = { ...base, 'docs/index.html': f('di') }
    expect(lookupPath(m, 'index.html', false, 'docs/')?.path).toBe('docs/index.html')
  })
  it('miss without fallback → null', () => expect(lookupPath(base, 'index.html', false, 'settings')).toBeNull())
  it('miss with fallback, no extension → entry', () => expect(lookupPath(base, 'index.html', true, 'settings/profile')?.path).toBe('index.html'))
  it('miss with fallback, has extension → null', () => expect(lookupPath(base, 'index.html', true, 'missing.js')).toBeNull())
  it('traversal-looking path → null, never throws', () => expect(lookupPath(base, 'index.html', true, '../secret')).toBeNull())
})
```

`serve.test.ts` (Review Focus #3 lives here):

```ts
import { describe, it, expect } from 'vitest'
import { parseArtifactUrl, decideArtifactRequest, artifactHeaders, ARTIFACT_CSP } from './serve'
import type { Manifest } from './limits'

const file = { key: 'k', sha256: 's', size: 1, contentType: 'text/html; charset=utf-8' }
const manifest: Manifest = { 'index.html': file, 'my chart.png': { ...file, contentType: 'image/png' } }
const found = (isPublic: boolean) => ({ artifactId: 'id1', slug: 'demo', isPublic, manifest, entry: 'index.html', spaFallback: false })
const input = (o: Partial<Parameters<typeof decideArtifactRequest>[0]>) => ({
  pathname: '/artifact/demo/', search: '', found: found(true), hasSession: false, tokenStatus: 'absent' as const,
  isNavigation: true, mintToken: () => 'TOK', ...o
})

describe('parseArtifactUrl', () => {
  it('slug only, no slash', () => expect(parseArtifactUrl('/artifact/demo')).toEqual({ slug: 'demo', token: null, path: '', trailingSlash: false }))
  it('slug with slash', () => expect(parseArtifactUrl('/artifact/demo/')).toEqual({ slug: 'demo', token: null, path: '', trailingSlash: true }))
  it('token + path', () => expect(parseArtifactUrl('/artifact/demo/~abc.def/assets/a.js')).toEqual({ slug: 'demo', token: 'abc.def', path: 'assets/a.js', trailingSlash: true }))
  it('decodes percent-encoding once', () => expect(parseArtifactUrl('/artifact/demo/my%20chart.png')?.path).toBe('my chart.png'))
  it('encoded traversal stays a literal miss', () => expect(parseArtifactUrl('/artifact/demo/%2e%2e/x')?.path).toBe('../x'))
  it('bad percent-encoding → null', () => expect(parseArtifactUrl('/artifact/demo/%E0%A4%A')).toBeNull())
  it('invalid slug → null', () => expect(parseArtifactUrl('/artifact/Bad_Slug/')).toBeNull())
  it('collapses double slashes in the path', () => expect(parseArtifactUrl('/artifact/demo/a//b.js')?.path).toBe('a/b.js'))
})

describe('decideArtifactRequest', () => {
  it('adds the trailing slash (keeps the query)', () => {
    expect(decideArtifactRequest(input({ pathname: '/artifact/demo', search: '?x=1' }))).toEqual({ kind: 'redirect', status: 301, location: '/artifact/demo/?x=1' })
  })
  it('public serves the entry', () => {
    const d = decideArtifactRequest(input({}))
    expect(d).toMatchObject({ kind: 'serve', path: 'index.html', isPublic: true })
  })
  it('public ignores a token segment', () => {
    expect(decideArtifactRequest(input({ pathname: '/artifact/demo/~junk/my%20chart.png' }))).toMatchObject({ kind: 'serve', path: 'my chart.png' })
  })
  it('missing artifact → not_found', () => expect(decideArtifactRequest(input({ found: null }))).toEqual({ kind: 'not_found' }))
  it('encoded traversal → not_found', () => expect(decideArtifactRequest(input({ pathname: '/artifact/demo/%2e%2e/etc/passwd' }))).toEqual({ kind: 'not_found' }))
  it('private, no session, no token, navigation → login', () => {
    expect(decideArtifactRequest(input({ found: found(false) }))).toEqual({ kind: 'redirect', status: 302, location: '/login?redirect=%2Fartifact%2Fdemo%2F' })
  })
  it('private, no session, subresource → not_found (same as missing — no slug leak)', () => {
    expect(decideArtifactRequest(input({ found: found(false), isNavigation: false, pathname: '/artifact/demo/app.js' }))).toEqual({ kind: 'not_found' })
  })
  it('private + session, no token → token redirect, same path', () => {
    expect(decideArtifactRequest(input({ found: found(false), hasSession: true, pathname: '/artifact/demo/my%20chart.png' })))
      .toEqual({ kind: 'redirect', status: 302, location: '/artifact/demo/~TOK/my%20chart.png' })
  })
  it('private + valid token serves without a session', () => {
    expect(decideArtifactRequest(input({ found: found(false), tokenStatus: 'ok', pathname: '/artifact/demo/~TOK/' }))).toMatchObject({ kind: 'serve', path: 'index.html', isPublic: false })
  })
  it('private + expired token, navigation → back through the session check (strip the token)', () => {
    expect(decideArtifactRequest(input({ found: found(false), tokenStatus: 'expired', pathname: '/artifact/demo/~OLD/x.png', hasSession: true })))
      .toEqual({ kind: 'redirect', status: 302, location: '/artifact/demo/~TOK/x.png' })
  })
  it('private + invalid token, subresource → forbidden', () => {
    expect(decideArtifactRequest(input({ found: found(false), tokenStatus: 'invalid', isNavigation: false, pathname: '/artifact/demo/~BAD/a.js' }))).toEqual({ kind: 'forbidden' })
  })
})

describe('artifactHeaders', () => {
  it('always sandboxes', () => {
    expect(ARTIFACT_CSP).toBe('sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads')
    for (const pub of [true, false]) {
      const h = artifactHeaders(pub)
      expect(h['content-security-policy']).toBe(ARTIFACT_CSP)
      expect(h['x-content-type-options']).toBe('nosniff')
      expect(h['referrer-policy']).toBe('no-referrer')
    }
    expect(artifactHeaders(true)['cache-control']).toBe('public, max-age=60')
    expect(artifactHeaders(false)['cache-control']).toBe('private, no-store')
  })
})
```

- [ ] **Step 2: Run both** — `pnpm vitest run packages/core/src/lib/artifacts/` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `manifest.ts`**

```ts
// Cycle 86 (spec §3–§5): pure manifest operations.
import { ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES, ArtifactError, normalizeArtifactPath, type Manifest, type ManifestEntry } from './limits'

export const isDataPath = (p: string) => p.startsWith('data/')

export function mergeManifest(prev: Manifest | null, next: Manifest, merge: boolean): Manifest {
  return merge && prev ? { ...prev, ...next } : { ...next }
}

export function onlyDataChanged(prev: Manifest, next: Manifest): boolean {
  const paths = new Set([...Object.keys(prev), ...Object.keys(next)])
  let changed = false
  for (const p of paths) {
    if (prev[p]?.sha256 === next[p]?.sha256) continue
    if (!isDataPath(p)) return false
    changed = true
  }
  return changed
}

export function manifestStats(m: Manifest) {
  const files = Object.values(m)
  return { files: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0) }
}

export function validateManifest(m: Manifest, entry: string): void {
  const { files, totalBytes } = manifestStats(m)
  if (files > ARTIFACT_MAX_FILES) throw new ArtifactError(`bundle has ${files} files; the limit is ${ARTIFACT_MAX_FILES}`, 'too_many')
  if (totalBytes > ARTIFACT_MAX_TOTAL_BYTES) throw new ArtifactError(`bundle is ${totalBytes} bytes; the limit is 25 MB`, 'too_large')
  if (!m[entry]) throw new ArtifactError(`entry ${entry} not found — did you publish the build output directory?`, 'no_entry')
}

export function lookupPath(m: Manifest, entry: string, spaFallback: boolean, reqPath: string): { path: string; file: ManifestEntry } | null {
  if (reqPath === '' ) return m[entry] ? { path: entry, file: m[entry]! } : null
  let p: string
  try { p = normalizeArtifactPath(reqPath.endsWith('/') ? reqPath + 'index.html' : reqPath) } catch { return null }
  if (m[p]) return { path: p, file: m[p]! }
  const last = p.split('/').pop()!
  if (spaFallback && !last.includes('.') && m[entry]) return { path: entry, file: m[entry]! }
  return null
}
```

- [ ] **Step 4: Implement `serve.ts`**

```ts
// Cycle 86 (spec §5): the serving route's decisions, kept pure so every branch is unit-tested.
import { SLUG_RE, type Manifest, type ManifestEntry } from './limits'
import { lookupPath } from './manifest'

export const ARTIFACT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

export function artifactHeaders(isPublic: boolean): Record<string, string> {
  return {
    'content-security-policy': ARTIFACT_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': isPublic ? 'public, max-age=60' : 'private, no-store'
  }
}

export function parseArtifactUrl(pathname: string) {
  const m = /^\/artifact\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!m) return null
  const slug = m[1]!
  if (!SLUG_RE.test(slug)) return null
  const rest = m[2] ?? ''
  let segs = rest.split('/').slice(1) // '' for '/'
  let token: string | null = null
  if (segs[0]?.startsWith('~')) { token = segs[0].slice(1); segs = segs.slice(1) }
  let path: string
  try { path = segs.map(s => decodeURIComponent(s)).filter(s => s !== '').join('/') } catch { return null }
  if (rest.endsWith('/') && path) path += '/'
  return { slug, token, path, trailingSlash: rest !== '' }
}

export type ServeDecision =
  | { kind: 'redirect'; status: 301 | 302; location: string }
  | { kind: 'serve'; path: string; file: ManifestEntry; isPublic: boolean }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }

export interface DecideInput {
  pathname: string
  search: string
  found: { artifactId: string; slug: string; isPublic: boolean; manifest: Manifest; entry: string; spaFallback: boolean } | null
  hasSession: boolean
  tokenStatus: 'ok' | 'expired' | 'invalid' | 'absent'
  isNavigation: boolean
  mintToken: () => string
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export function decideArtifactRequest(i: DecideInput): ServeDecision {
  const u = parseArtifactUrl(i.pathname)
  if (!u || !i.found) return { kind: 'not_found' }
  if (!u.trailingSlash) return { kind: 'redirect', status: 301, location: `/artifact/${u.slug}/${i.search}` }
  const a = i.found
  const serve = (): ServeDecision => {
    const hit = lookupPath(a.manifest, a.entry, a.spaFallback, u.path)
    return hit ? { kind: 'serve', path: hit.path, file: hit.file, isPublic: a.isPublic } : { kind: 'not_found' }
  }
  if (a.isPublic) return serve()
  if (u.token !== null && i.tokenStatus === 'ok') return serve()
  // No usable token: a navigation goes (back) through the session check; a subresource can't.
  if (!i.isNavigation) return u.token !== null ? { kind: 'forbidden' } : { kind: 'not_found' }
  if (i.hasSession) return { kind: 'redirect', status: 302, location: `/artifact/${u.slug}/~${i.mintToken()}/${encodePath(u.path)}${i.search}` }
  return { kind: 'redirect', status: 302, location: `/login?redirect=${encodeURIComponent(`/artifact/${u.slug}/`)}` }
}
```

Note: the "private, no session, subresource, no token → not_found" branch is deliberate (identical to a missing slug). A private *navigation* without a session redirects to login — that reveals existence only to a browser navigation, and the spec accepts it (§5 step 1).

- [ ] **Step 5: Run** `pnpm vitest run packages/core/src/lib/artifacts/` — Expected: PASS. Fix the implementation (not the tests) until green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lib/artifacts/manifest.ts packages/core/src/lib/artifacts/manifest.test.ts packages/core/src/lib/artifacts/serve.ts packages/core/src/lib/artifacts/serve.test.ts
git commit -m "feat(artifacts): manifest ops and request decisions"
```

---

### Task 3: Private view tokens

**Files:**
- Create: `packages/core/src/lib/artifacts/token.ts`
- Test: `packages/core/src/lib/artifacts/token.test.ts`

**Interfaces:**
- Produces:
  - `ARTIFACT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000`
  - `signViewToken(artifactId: string, o?: { now?: number; secret?: string }): string`
  - `verifyViewToken(token: string, artifactId: string, o?: { now?: number; secret?: string }): 'ok' | 'expired' | 'invalid'`
  - `secret` defaults to `coreConfig().betterAuthSecret`; if that is empty/undefined, both functions throw `Error('BETTER_AUTH_SECRET is not set')`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { signViewToken, verifyViewToken, ARTIFACT_TOKEN_TTL_MS } from './token'

const S = { secret: 'test-secret-123' }
const ID = '6f1c1b0e-0000-4000-8000-000000000001'

describe('view tokens', () => {
  it('round-trips', () => expect(verifyViewToken(signViewToken(ID, { ...S, now: 1000 }), ID, { ...S, now: 2000 })).toBe('ok'))
  it('is url-path safe', () => expect(signViewToken(ID, S)).toMatch(/^[A-Za-z0-9_.-]+$/))
  it('expires after the TTL', () => {
    const t = signViewToken(ID, { ...S, now: 0 })
    expect(verifyViewToken(t, ID, { ...S, now: ARTIFACT_TOKEN_TTL_MS + 1 })).toBe('expired')
  })
  it('is bound to the artifact', () => expect(verifyViewToken(signViewToken(ID, S), ID.replace(/1$/, '2'), S)).toBe('invalid'))
  it('rejects a different secret', () => expect(verifyViewToken(signViewToken(ID, S), ID, { secret: 'other' })).toBe('invalid'))
  it('rejects tampering of the expiry', () => {
    const [body, sig] = signViewToken(ID, { ...S, now: 0 }).split('.')
    const forged = Buffer.from(`${ID}.${Date.now() + 1e9}`).toString('base64url') + '.' + sig
    expect(verifyViewToken(forged, ID, S)).toBe('invalid')
    expect(body).toBeTruthy()
  })
  it.each(['', 'x', 'a.b.c', '.', 'abc.'])('rejects garbage %j', t => expect(verifyViewToken(t, ID, S)).toBe('invalid'))
  it('throws without a secret', () => expect(() => signViewToken(ID, { secret: '' })).toThrow(/BETTER_AUTH_SECRET/))
})
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/lib/artifacts/token.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// Cycle 86 (spec §5): short-lived path tokens for private artifacts. The sandboxed page is an opaque
// origin, so its subresource requests don't carry the session cookie; the token in the path does.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { coreConfig } from '../../config'

export const ARTIFACT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000

function key(secret: string | undefined): Buffer {
  const s = secret ?? coreConfig().betterAuthSecret
  if (!s) throw new Error('BETTER_AUTH_SECRET is not set')
  return createHmac('sha256', s).update('artifact-view:v1').digest()
}
const mac = (k: Buffer, body: string) => createHmac('sha256', k).update(body).digest('base64url')

export function signViewToken(artifactId: string, o: { now?: number; secret?: string } = {}): string {
  const k = key(o.secret)
  const body = Buffer.from(`${artifactId}.${(o.now ?? Date.now()) + ARTIFACT_TOKEN_TTL_MS}`).toString('base64url')
  return `${body}.${mac(k, body)}`
}

export function verifyViewToken(token: string, artifactId: string, o: { now?: number; secret?: string } = {}): 'ok' | 'expired' | 'invalid' {
  const k = key(o.secret)
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return 'invalid'
  const want = Buffer.from(mac(k, parts[0]))
  const got = Buffer.from(parts[1])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid'
  const decoded = Buffer.from(parts[0], 'base64url').toString()
  const dot = decoded.lastIndexOf('.')
  if (decoded.slice(0, dot) !== artifactId) return 'invalid'
  const exp = Number(decoded.slice(dot + 1))
  if (!Number.isFinite(exp)) return 'invalid'
  return (o.now ?? Date.now()) > exp ? 'expired' : 'ok'
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add packages/core/src/lib/artifacts/token.* && git commit -m "feat(artifacts): signed private view tokens"`

---

### Task 4: Service (DB + storage) and live resource type

**Files:**
- Create: `packages/core/src/lib/artifacts/service.ts`, `packages/core/src/shared/types/artifacts.ts`
- Modify: `packages/core/src/shared/types/live.ts` (add `| 'artifact'` to `ResourceName`)
- Test: `packages/core/src/lib/artifacts/service.db.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`normalizeArtifactPath`, `contentTypeFor`, `slugProblem`, `slugFromTitle`, `ArtifactError`, `mergeManifest`, `onlyDataChanged`, `validateManifest`, `manifestStats`); `storage()` from `../../utils/storage`; `useDb()` from `../../db`; `publishChange` from `../../utils/live-bus`; `coreConfig().betterAuthUrl`.
- Produces:
  ```ts
  // shared/types/artifacts.ts
  export interface ArtifactDTO { id: string; slug: string; title: string; description: string | null; isPublic: boolean
    projectId: string | null; conversationId: string | null; currentVersion: number | null; versionCount: number
    fileCount: number; totalBytes: number; url: string; createdAt: string; updatedAt: string }
  export interface ArtifactVersionDTO { id: string; version: number; entry: string; fileCount: number; totalBytes: number; createdAt: string; current: boolean }
  export interface ArtifactDetailDTO extends ArtifactDTO { versions: ArtifactVersionDTO[] }

  // lib/artifacts/service.ts
  export interface PublishInput { slug?: string; title?: string; description?: string | null
    files: Array<{ path: string; content: Buffer | string }>; entry?: string; spaFallback?: boolean
    isPublic?: boolean; projectId?: string | null; conversationId?: string | null; merge?: boolean }
  export interface PublishResult { artifact: ArtifactDTO; version: number; created: boolean; newVersion: boolean; previousVersionId: string | null }
  export function artifactUrl(slug: string): string            // `${betterAuthUrl without trailing /}/artifact/${slug}/`
  export async function publishArtifact(input: PublishInput): Promise<PublishResult>
  export async function editArtifact(id: string, patch: { title?: string; description?: string | null; slug?: string; isPublic?: boolean; projectId?: string | null; rollbackTo?: number }): Promise<ArtifactDTO | null>
  export async function setCurrentVersion(id: string, versionId: string | null): Promise<void>  // undo helper
  export async function listArtifacts(o?: { projectId?: string; limit?: number }): Promise<ArtifactDTO[]>   // newest updated first, non-deleted
  export async function getArtifactDetail(id: string): Promise<ArtifactDetailDTO | null>
  export async function findServable(slug: string): Promise<{ artifactId: string; slug: string; isPublic: boolean; manifest: Manifest; entry: string; spaFallback: boolean } | null>
  export async function resolveArtifactRef(ref: string): Promise<string | null>  // id (uuid) or slug → id, non-deleted
  export async function deleteArtifact(id: string): Promise<boolean>   // soft delete
  export async function restoreArtifact(id: string): Promise<boolean>  // undo of delete; fails (false) if the slug was reused meanwhile
  ```
  Every write calls `publishChange({ resource: 'artifact', action, id })` once, after the DB commit.

Rules to implement (spec §4):
1. Validate & normalise every path; reject duplicates after normalisation; `contentTypeFor` null → `ArtifactError('<path>: content type not allowed', 'bad_type')`; any file > `ARTIFACT_MAX_FILE_BYTES` → `too_large` naming the file.
2. `put` every blob to storage **before** opening the DB transaction (`Readable.from(buffer)`, `hint.contentType`). Build `next` manifest entries `{ key, sha256, size, contentType }`.
3. In one transaction: `select … for update` the live artifact row by slug (Review Focus #4 — serialises concurrent publishes). If none: require `title`; insert artifact (slug = given or `uniqueSlug(slugFromTitle(title))` which appends `-2`, `-3`… against live rows; explicit slug → `slugProblem` check) + version 1, set `current_version_id`. If found: `merged = mergeManifest(current, next, merge)`; `validateManifest(merged, entry ?? currentVersion.entry)`; if `onlyDataChanged(current, merged)` → update current version's manifest + total_bytes in place (`newVersion: false`); else if manifests are identical and entry/spaFallback unchanged → no new version (`newVersion: false`); else insert version `max+1`, move `current_version_id`. Apply `title/description/isPublic/projectId` when provided; bump `updated_at`.
4. Insert-race for a brand-new slug: catch the unique violation on `artifacts_slug_live_uidx` (pg code `23505`) once and retry the whole transaction (the second attempt finds the row and takes the update path).

- [ ] **Step 1: Write the failing DB test** — `service.db.test.ts`. Use a unique slug prefix per run (`t-${Date.now()}`) and clean up rows you created in `afterAll` (hard delete by id). Point storage at a temp dir: `process.env.STORAGE_LOCAL_DIR = mkdtempSync(...)` + `_resetStorage()` **before** importing the service (look at an existing `*.db.test.ts` that touches storage, e.g. grep `_resetStorage` in `test/`, and copy its setup).

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { publishArtifact, editArtifact, getArtifactDetail, findServable, deleteArtifact, listArtifacts } from './service'

const P = `t${Date.now().toString(36)}`
const created: string[] = []
const html = (s: string) => ({ path: 'index.html', content: `<h1>${s}</h1>` })

describe('publishArtifact', () => {
  it('creates v1 with a slug from the title, private by default', async () => {
    const r = await publishArtifact({ title: `${P} Sales Q3`, files: [html('a')] })
    created.push(r.artifact.id)
    expect(r).toMatchObject({ created: true, newVersion: true, version: 1 })
    expect(r.artifact.slug).toBe(`${P}-sales-q3`)
    expect(r.artifact.isPublic).toBe(false)
    expect(r.artifact.url).toMatch(new RegExp(`/artifact/${P}-sales-q3/$`))
  })

  it('suffixes a colliding generated slug', async () => {
    const r = await publishArtifact({ title: `${P} Sales Q3`, files: [html('b')] })
    created.push(r.artifact.id)
    expect(r.artifact.slug).toBe(`${P}-sales-q3-2`)
  })

  it('republishing to a slug makes a new version; identical content does not', async () => {
    const slug = `${P}-ver`
    const a = await publishArtifact({ slug, title: 'v', files: [html('1')] }); created.push(a.artifact.id)
    const b = await publishArtifact({ slug, files: [html('2')] })
    expect(b).toMatchObject({ created: false, newVersion: true, version: 2, previousVersionId: expect.any(String) })
    const c = await publishArtifact({ slug, files: [html('2')] })
    expect(c).toMatchObject({ newVersion: false, version: 2 })
  })

  it('data/ changes patch in place; merge keeps other files', async () => {
    const slug = `${P}-data`
    const a = await publishArtifact({ slug, title: 'd', files: [html('x'), { path: 'data/x.json', content: '{"n":1}' }] }); created.push(a.artifact.id)
    const b = await publishArtifact({ slug, merge: true, files: [{ path: 'data/x.json', content: '{"n":2}' }] })
    expect(b).toMatchObject({ newVersion: false, version: 1 })
    const s = await findServable(slug)
    expect(Object.keys(s!.manifest).sort()).toEqual(['data/x.json', 'index.html'])
  })

  it('rejects bad input with ArtifactError messages naming the file', async () => {
    await expect(publishArtifact({ title: 't', slug: `${P}-bad`, files: [html('x'), { path: 'v.mov', content: 'x' }] })).rejects.toThrow(/v\.mov: content type not allowed/)
    await expect(publishArtifact({ title: 't', slug: `${P}-bad`, files: [{ path: 'app.js', content: 'x' }] })).rejects.toThrow(/entry index\.html not found/)
    await expect(publishArtifact({ title: 't', slug: 'Bad_Slug', files: [html('x')] })).rejects.toThrow(/slug/)
    expect(await findServable(`${P}-bad`)).toBeNull() // nothing half-written
  })

  it('concurrent publishes to one slug both succeed (Review Focus #4)', async () => {
    const slug = `${P}-race`
    const a = await publishArtifact({ slug, title: 'r', files: [html('0')] }); created.push(a.artifact.id)
    const [x, y] = await Promise.all([
      publishArtifact({ slug, files: [html('1')] }),
      publishArtifact({ slug, files: [html('2')] })
    ])
    expect(new Set([x.version, y.version])).toEqual(new Set([2, 3]))
  })

  it('concurrent first publishes of a new slug both succeed', async () => {
    const slug = `${P}-race-new`
    const [x, y] = await Promise.all([
      publishArtifact({ slug, title: 'n', files: [html('1')] }),
      publishArtifact({ slug, title: 'n', files: [html('2')] })
    ])
    created.push(x.artifact.id)
    expect(x.artifact.id).toBe(y.artifact.id)
  })

  it('a deleted slug can be reused by a new artifact (Review Focus #5)', async () => {
    const slug = `${P}-reuse`
    const a = await publishArtifact({ slug, title: 'old', files: [html('old')] }); created.push(a.artifact.id)
    await deleteArtifact(a.artifact.id)
    expect(await findServable(slug)).toBeNull()
    const b = await publishArtifact({ slug, title: 'new', files: [html('new')] }); created.push(b.artifact.id)
    expect(b.created).toBe(true)
    expect((await findServable(slug))!.artifactId).toBe(b.artifact.id)
  })
})

describe('editArtifact', () => {
  it('flips visibility, renames the slug, rolls back', async () => {
    const slug = `${P}-edit`
    const a = await publishArtifact({ slug, title: 'e', files: [html('1')] }); created.push(a.artifact.id)
    await publishArtifact({ slug, files: [html('2')] })
    const e = await editArtifact(a.artifact.id, { isPublic: true, slug: `${P}-edited`, rollbackTo: 1 })
    expect(e).toMatchObject({ isPublic: true, slug: `${P}-edited`, currentVersion: 1 })
    const d = await getArtifactDetail(a.artifact.id)
    expect(d!.versions.map(v => [v.version, v.current])).toEqual([[2, false], [1, true]])
    await expect(editArtifact(a.artifact.id, { rollbackTo: 9 })).rejects.toThrow(/version 9/)
  })
})

describe('listArtifacts', () => {
  it('excludes deleted and orders by updated desc', async () => {
    const list = await listArtifacts({ limit: 200 })
    expect(list.every(a => !a.slug.endsWith('-reuse') || a.title === 'new')).toBe(true)
  })
})

afterAll(async () => {
  const { useDb } = await import('../../db')
  const { artifacts } = await import('../../db/schema')
  const { inArray } = await import('drizzle-orm')
  if (created.length) await useDb().delete(artifacts).where(inArray(artifacts.id, created))
})
```

(If the hard delete fails on the circular FK, null `current_version_id` first in `afterAll`.)

- [ ] **Step 2: Run** the DB test (see Global Constraints for the command) — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `shared/types/artifacts.ts` (the DTOs above), add `'artifact'` to `ResourceName`, then `service.ts` per the rules above. DTO mapping helper `toDTO(row, version, versionCount)`; ISO strings for dates. `artifactUrl` uses `coreConfig().betterAuthUrl` (strip trailing `/`; fall back to `''` so a relative URL is returned in tests without the env).

- [ ] **Step 4: Run** the DB test — Expected: PASS. Then `pnpm typecheck` — Expected: PASS (the `ResourceName` union change may require an entry wherever an exhaustive map over it exists — add `artifact` there).

- [ ] **Step 5: Mutation check (Review Focus #4):** temporarily remove `.for('update')` from the select, re-run the race test, confirm it goes red (unique violation on version), then restore with `git checkout -- packages/core/src/lib/artifacts/service.ts` **only if you committed first** — so commit before mutating, and restore via `git checkout`. Never stack mutations.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lib/artifacts/service.ts packages/core/src/lib/artifacts/service.db.test.ts packages/core/src/shared/types/artifacts.ts packages/core/src/shared/types/live.ts
git commit -m "feat(artifacts): publish/edit/list service with versioning and in-place data updates"
```

---

### Task 5: Serving route + login redirect

**Files:**
- Create: `server/routes/artifact/[...rest].ts`
- Modify (only if needed): `app/pages/login.vue` (honour `?redirect=`)
- Test: `test/artifact-route.test.ts`

**Interfaces:**
- Consumes: `decideArtifactRequest`, `artifactHeaders` (Task 2), `verifyViewToken`, `signViewToken` (Task 3), `findServable` (Task 4), `storage().get(key)`.

Route logic:

```ts
// Cycle 86 (spec §5): /artifact/<slug>/… — outside /api, so it does its own auth. All decisions are
// in @mymind/core/lib/artifacts/serve (unit-tested); this file only does IO.
import { decideArtifactRequest, artifactHeaders, parseArtifactUrl } from '@mymind/core/lib/artifacts/serve'
import { signViewToken, verifyViewToken } from '@mymind/core/lib/artifacts/token'
import { findServable } from '@mymind/core/lib/artifacts/service'
import { storage } from '@mymind/core/utils/storage'

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  const method = event.method
  // Headers go on EVERY response, including 404 and redirects (spec §5).
  const parsed = parseArtifactUrl(url.pathname)
  const found = parsed ? await findServable(parsed.slug) : null
  const send404 = () => {
    setResponseHeaders(event, artifactHeaders(false))
    setResponseStatus(event, 404)
    setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    return 'Not found'
  }
  if (method !== 'GET' && method !== 'HEAD') return send404()
  const tokenStatus = !parsed?.token || !found ? 'absent' as const : verifyViewToken(parsed.token, found.artifactId)
  const needsSession = !!found && !found.isPublic && tokenStatus !== 'ok'
  const session = needsSession ? await useAuth().api.getSession({ headers: event.headers as Headers }).catch(() => null) : null
  const d = decideArtifactRequest({
    pathname: url.pathname, search: url.search, found,
    hasSession: !!session?.user, tokenStatus,
    isNavigation: getHeader(event, 'sec-fetch-dest') === 'document' || getHeader(event, 'sec-fetch-dest') === 'iframe' || !getHeader(event, 'sec-fetch-dest'),
    mintToken: () => signViewToken(found!.artifactId)
  })
  if (d.kind === 'not_found') return send404()
  setResponseHeaders(event, artifactHeaders(d.kind === 'serve' ? d.isPublic : !!found?.isPublic))
  if (d.kind === 'forbidden') { setResponseStatus(event, 403); return 'Forbidden' }
  if (d.kind === 'redirect') return sendRedirect(event, d.location, d.status)
  setResponseHeader(event, 'content-type', d.file.contentType)
  setResponseHeader(event, 'content-length', d.file.size)
  setResponseHeader(event, 'etag', `"${d.file.sha256}"`)
  if (getHeader(event, 'if-none-match') === `"${d.file.sha256}"`) { setResponseStatus(event, 304); return '' }
  if (method === 'HEAD') return ''
  const { stream } = await storage().get(d.file.key)
  return sendStream(event, stream)
})
```

Notes for the implementer:
- `isNavigation`: an iframe load has `Sec-Fetch-Dest: iframe`; a missing header (curl, old clients) counts as navigation. Script/style/fetch requests are `script`/`style`/`empty` → not navigation.
- `useAuth()` is the same server util `server/middleware/auth.ts` uses (auto-imported in Nitro).
- `sendRedirect` writes its own small HTML body; headers set before it persist — verify with the route test.

- [ ] **Step 1: Write the failing route test** — `test/artifact-route.test.ts`. Mock `@mymind/core/lib/artifacts/service` (`findServable`), `@mymind/core/utils/storage`, and the `useAuth` global; import the handler and drive it with an h3 test event. Find an existing route test that does this (e.g. `test/agent-runs-route.test.ts`, `test/agent-wake-route.test.ts`) and copy its event-construction helper exactly. Cases:
  1. public `/artifact/demo/` → 200, body streamed, `content-security-policy` = `ARTIFACT_CSP`, `cache-control: public, max-age=60`.
  2. `/artifact/demo` → 301 to `/artifact/demo/` **with** the CSP header.
  3. unknown slug → 404 with the CSP header.
  4. private, no session, `sec-fetch-dest: document` → 302 to `/login?redirect=%2Fartifact%2Fdemo%2F`.
  5. private, session, `sec-fetch-dest: document` → 302 to `/artifact/demo/~<token>/`; then requesting that location with `sec-fetch-dest: script` and no session → 200 and `cache-control: private, no-store`.
  6. private, no session, `sec-fetch-dest: script`, no token → 404 (body identical to case 3).
  7. `POST` → 404.
  8. `if-none-match` equal to the etag → 304.

  Use a fixed `BETTER_AUTH_SECRET` via the core config test bridge (see `test/setup/core-bridge.ts`) or `vi.stubEnv`.

- [ ] **Step 2: Run** `pnpm vitest run test/artifact-route.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement the route** (above). Run again — Expected: PASS.
- [ ] **Step 4: Login redirect.** Read `app/pages/login.vue`. If it doesn't already honour `?redirect=`, add: after a successful sign-in, read `route.query.redirect`; accept it only if it's a string starting with `/` and not `//` or `/\`; if it starts with `/artifact/` use `window.location.assign(target)` (a Nitro route, not an SPA page — `navigateTo` would 404 in the SPA router); else `navigateTo(target)`. Otherwise keep the existing default destination.
- [ ] **Step 5: Smoke in dev.** Start the dev server on a spare port per `.claude/skills/browser-testing/SKILL.md` (write a scratchpad `.sh` if the worktree guard refuses compound commands). Insert a public artifact via a tiny `tsx` script calling `publishArtifact` (with `initCore()` — see CLAUDE.md), then `curl -sI http://localhost:<port>/artifact/<slug>/` — Expected: 200 and the CSP header. Confirm the SPA does not intercept `/artifact/**`.
- [ ] **Step 6: Commit** — `git add server/routes/artifact test/artifact-route.test.ts app/pages/login.vue && git commit -m "feat(artifacts): sandboxed serving route with private token redirect"`

---

### Task 6: Read a workspace directory into a bundle

**Files:**
- Create: `packages/core/src/lib/artifacts/workspace-bundle.ts`
- Test: `packages/core/src/lib/artifacts/workspace-bundle.test.ts`

**Interfaces:**
- Consumes: `workspaceRuntime().manager.exec(workspaceId, script, { input, capBytes, timeoutSec, tainted?, offline?, signal? })` (returns `SandboxExecResult` with `stdout`, `stderr`, `exitCode`, `truncated`, `timedOut`, `tainted`); `CHUNK_BYTES` from `../sandbox/paths`; `shq`, `META_DIR` from `../sandbox/fs-ops`; `maskText`, `secretValues`, `SecretStoreUnavailableError` from `../sandbox/secrets`; `isTextPath`, limits, `ArtifactError` (Task 1); `executionMode` from `../agent/runtime/execution-mode`.
- Produces:
  - `BUNDLE_LIST_SCRIPT: string`, `BUNDLE_READ_SCRIPT: string`
  - `planReads(files: Array<{ path: string; size: number }>, max?: number): Array<Array<{ path: string; offset: number; length: number }>>` — packs pieces into batches whose lengths sum ≤ `max` (default `CHUNK_BYTES`); a file larger than `max` is split across batches.
  - `readWorkspaceBundle(workspaceId: string, dir: string, o?: { tainted?: boolean; offline?: boolean; signal?: AbortSignal }): Promise<{ files: Array<{ path: string; content: Buffer }>; masked: number }>` — throws `ArtifactError` for limit breaches / missing dir, and `Error('…remote…')` when `executionMode() === 'remote'` (message: `publishing from a workspace only works inside Bridget's runs`).

Script behaviour (Python, run with `python3 -I -c`, input JSON on stdin; copy the `PRELUDE` path-resolution approach from `packages/core/src/lib/sandbox/view.ts` — realpath must stay under `/workspace`):
- **List** `{dir}`: resolve `dir` (must be a directory). `os.walk(full, followlinks=False)`; prune dirs that start with `.` or are `node_modules`; skip symlinked files and non-regular files. Paths relative to `dir`, `/`-joined, sorted. While walking: stop and return `{"error":"too_many","message":"more than 500 files under <dir>"}` at file 501; `{"error":"too_large","path":p}` when one file > 10 MB or the running total > 25 MB. Else `{"files":[{"path","size"}...]}`.
- **Read** `{dir, items:[{path,offset,length}]}`: for each item resolve `dir/path` with the same checks and output one line per item: `{"path":..,"size":..}\n<base64>\n`. Total read ≤ `CHUNK_BYTES` (refuse otherwise).

`readWorkspaceBundle` then: list → `planReads` → exec each batch (capBytes `1024 * 1024`) → reassemble per path (verify the assembled length equals the listed size, else `Error('<path> changed while publishing')`) → for `isTextPath` files decode UTF-8, `maskText(text, values)`, re-encode, count `masked` files whose content changed. `secretValues()` throwing → `ArtifactError('publish refused — the secret store is unreadable, so secret values could not be masked', 'bad_type')`.

- [ ] **Step 1: Failing tests.** Run the real scripts against a temp dir by stubbing the runtime: `setWorkspaceRuntime({ manager: { exec: async (_id, script, o) => run(script, o) } } as any)` where `run` spawns `sh -c script` with `cwd = tmpDir`, pipes `o.input` to stdin and returns `{ stdout, stderr, exitCode, truncated: stdout.length > o.capBytes, timedOut: false, tainted: false }`. Note the scripts treat `os.getcwd()` as the workspace root, so `cwd = tmpDir` mirrors the container. Mock `../sandbox/secrets` so `secretValues` resolves `['sk-SECRET-123']` (and throws in one test).

```ts
// cases
it('reads a built dist/ including nested and binary files', async () => {
  write('dist/index.html', '<script src="./assets/a.js"></script>')
  write('dist/assets/a.js', 'console.log(1)')
  writeBin('dist/img/p.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  const r = await readWorkspaceBundle('ws', 'dist')
  expect(r.files.map(f => f.path).sort()).toEqual(['assets/a.js', 'img/p.png', 'index.html'])
  expect(r.files.find(f => f.path === 'img/p.png')!.content).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
})
it('masks secrets in text files (Review Focus #1)', async () => {
  write('dist/index.html', 'ok'); write('dist/assets/a.js', 'const k="sk-SECRET-123"')
  const r = await readWorkspaceBundle('ws', 'dist')
  expect(r.files.find(f => f.path === 'assets/a.js')!.content.toString()).not.toContain('sk-SECRET-123')
  expect(r.masked).toBe(1)
})
it('refuses when the secret store is unreadable', ...)            // expect ArtifactError /secret store/
it('skips dot-dirs, node_modules and symlinks', ...)               // symlink dist/evil -> /etc/passwd is not in files
it('rejects a dir outside the workspace', ...)                      // '../' and an absolute path → ArtifactError bad_path
it('stops at 501 files', ...)                                       // create 501 tiny files → /more than 500 files/
it('rejects a single 10 MB+ file, naming it', ...)                  // sparse file via fs.truncateSync(p, 10*1024*1024+1)
it('reassembles a file larger than one chunk', ...)                 // 2 MB random file round-trips byte-exact
it('refuses in remote execution mode', ...)                         // mock executionMode → 'remote'
describe('planReads', () => {
  it('packs small files and splits big ones', () => {
    const b = planReads([{ path: 'a', size: 10 }, { path: 'b', size: 25 }, { path: 'c', size: 5 }], 20)
    expect(b).toEqual([
      [{ path: 'a', offset: 0, length: 10 }, { path: 'b', offset: 0, length: 10 }],
      [{ path: 'b', offset: 10, length: 15 }, { path: 'c', offset: 0, length: 5 }]
    ])
  })
  it('zero-byte files still get a piece', () => expect(planReads([{ path: 'e', size: 0 }], 20)).toEqual([[{ path: 'e', offset: 0, length: 0 }]]))
})
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/lib/artifacts/workspace-bundle.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the behaviour above. Keep scripts as fixed text; paths travel only as JSON on stdin.
- [ ] **Step 4: Run** — Expected: PASS. Then break the masking (skip `maskText`) and confirm the Review-Focus test goes red; restore via `git checkout` after committing first.
- [ ] **Step 5: Commit** — `git add packages/core/src/lib/artifacts/workspace-bundle.* && git commit -m "feat(artifacts): read a workspace directory into a bundle with limits and secret masking"`

---

### Task 7: Agent tools, conditional outbound, toolset registration

**Files:**
- Create: `packages/core/src/lib/agent/tools/artifacts.ts`, `packages/core/src/lib/artifacts/html-warnings.ts`
- Modify: `packages/core/src/lib/agent/types.ts` (add `outboundWhen`), `packages/core/src/lib/agent/ai-tools.ts:310`, `packages/core/src/lib/agent/judge/rules.ts:332`, `packages/core/src/lib/eval/approval-tools.ts:14`, `packages/core/src/lib/agent/toolsets.ts` (add `'artifacts'`), `packages/core/src/lib/agent/tools.ts` (register `...artifactTools`)
- Test: `packages/core/src/lib/agent/tools/artifacts.test.ts`, `packages/core/src/lib/artifacts/html-warnings.test.ts`, extend the existing gate test that covers `outbound` (grep `outboundGated\|outbound` in `test/agent-gate.test.ts` / `test/*ai-tools*`)

**Interfaces:**
- Consumes: service (Task 4), `readWorkspaceBundle` (Task 6), `workspaceRuntime().resolve(ctx.runId)` (returns `{ workspaceId }`), `runNetworkMode(ctx)` the way `export_to_document` uses it in `tools/workspace.ts`, `agentRuns` table (`conversationId`) to stamp the source chat from `ctx.runId`, `getProject(slug)` from `services/projects`.
- Produces:
  - `AgentTool.outboundWhen?: (args: Record<string, unknown>) => boolean` — "this call is outbound" for tools that are only sometimes outbound. Gate: `const outboundGated = (t.outbound === true || t.outboundWhen?.(input) === true) && tainted`. `judge/rules.ts`: treat `tool.outbound || tool.outboundWhen?.(input)` as outbound. `eval/approval-tools.ts`: include tools with `outboundWhen`.
  - `rootAbsoluteRefs(html: string, manifest: Manifest): string[]` — `src=`/`href=` values starting with a single `/` (not `//`) whose path without the leading `/` exists in the manifest.
  - `artifactTools: AgentTool[]` — `publish_artifact`, `edit_artifact`, `list_artifacts`, `delete_artifact`; all `toolset: 'artifacts'`.
  - Tool results (what the model and the chat card read): `publish_artifact` → `{ ok: true, id, slug, title, url, isPublic, version, newVersion, created, warnings: string[] }`; on `ArtifactError` → `{ ok: false, error: message }` (never a throw).

Tool definitions:
- `publish_artifact` — `kind: 'create'`, `outboundWhen: a => a.public === true`. Schema (zod): `title: z.string().min(1).max(200).optional()` (required on create — service enforces), `slug: z.string().optional()`, `description: z.string().max(1000).optional()`, `html: z.string().optional()`, `files: z.record(z.string(), z.string()).optional()`, `workspace_path: z.string().optional()`, `entry: z.string().optional()`, `spa_fallback: z.boolean().optional()`, `public: z.boolean().optional()`, `project: z.string().optional().describe('Project slug')`, `merge: z.boolean().optional()`. Exactly one of `html`/`files`/`workspace_path` (else `{ok:false,error}`). Description (≤ ~900 chars):
  > Publish a web page or built webapp as an artifact Tony can open at https://brain.costanzoclan.com/artifact/<slug>/ (also shown in chat). Use it whenever a chart, dashboard, demo or visual preview conveys something better than text. Pass `html` for a single self-contained page, or build in your workspace first (`pnpm build`; for Vite set `base: './'`) and pass `workspace_path` = the output dir (e.g. `dist`). Use relative asset paths. Pages run sandboxed: no localStorage/cookies, no MyMind API; CDN scripts are fine. Put refreshable data in `data/*.json`, fetch it relatively, and refresh it later with `files` + `merge: true` (updates in place, no new version). Republishing to the same slug makes a new version. Private unless `public: true`.
- Handler: resolve project slug → id (unknown slug → `{ok:false,error:'unknown project …'}`); look up `conversationId` from `ctx.runId` (absent on MCP → null); build `files` (`html` → `[{path:'index.html', content: html}]`; `files` record → array; `workspace_path` → `readWorkspaceBundle(workspaceId, path, { tainted: mode === 'tainted', offline: mode === 'offline', signal: ctx.signal })`); call `publishArtifact`; compute `warnings`: `rootAbsoluteRefs(entryHtml, manifest)` non-empty → `entry HTML references root-absolute paths (/assets/…) that will 404 under /artifact/<slug>/ — rebuild with base: './' (Vite) and republish`; `masked > 0` → `N file(s) had secret values masked`. `summary`: `published "<title>" v<N> → /artifact/<slug>/` | `updated data of "<title>" (v<N>, in place)` | `"<title>" unchanged`. `undo`: created → `deleteArtifact(id)`; new version → `setCurrentVersion(id, previousVersionId)`; in place → no undo (omit).
- `edit_artifact` — `kind: 'create'`, `outboundWhen: a => a.public === true`. Schema: `artifact: z.string().describe('Artifact id or slug')`, `title?`, `description?`, `slug?`, `public?: boolean`, `project?: string | null` (null clears), `rollback_to?: z.number().int().positive()`. Undo restores the previous `{title, description, slug, isPublic, projectId, currentVersionId}` snapshot.
- `list_artifacts` — `kind: 'read'`. Schema: `project?`, `limit?: z.number().int().min(1).max(100).optional()`. Result: array of `{ id, slug, title, url, isPublic, currentVersion, updatedAt }`.
- `delete_artifact` — `kind: 'destructive'`, `dangerous: true` (deletes always confirm, per Tony's autonomy rule), `describeApproval` → `{ command: 'delete artifact "<title>" (/artifact/<slug>/)', pattern: 'delete_artifact *' }` (match the `ApprovalRequest` shape used by other dangerous tools — read `tools/exec.ts` / `tools/gmail.ts`). Undo → `restoreArtifact(id)`.

Toolset entry (`toolsets.ts`): `artifacts: { core: false, description: 'publish an HTML page or built webapp as a viewable artifact (dashboards, demos, visual previews), or list/edit/delete artifacts' }`, and add `'artifacts'` to `ToolsetId`. Do NOT add it to `MCP_EXCLUDED_TOOLSETS` (delete_artifact is `dangerous`, so `isMcpExposed` already drops it from MCP).

- [ ] **Step 1: Failing tests.**
  - `html-warnings.test.ts`: `/assets/a.js` present in manifest → flagged; `./assets/a.js`, `//cdn.x/y.js`, `https://…`, `/missing.js` (not in manifest) → not flagged; both `src` and `href`, single/double quotes.
  - `artifacts.test.ts` (mock `../../artifacts/service`, `../../artifacts/workspace-bundle`, the runtime resolver and the DB lookup for the run):
    1. `html` publish calls `publishArtifact` with `[{path:'index.html'}]`, `isPublic: undefined`, returns `ok:true` + url.
    2. two of `html`/`files`/`workspace_path` → `ok:false`, service not called.
    3. `ArtifactError` from the service → `{ ok:false, error: <message> }`, no throw.
    4. Vite root-absolute HTML → `warnings` contains `base: './'` (Review Focus #2).
    5. `outboundWhen({ public: true })` true; `({})` and `({ public: false })` false — for both publish and edit.
    6. undo of a created artifact calls `deleteArtifact`; of a new version calls `setCurrentVersion(id, previousVersionId)`; in-place returns no `undo`.
    7. `delete_artifact.dangerous === true`.
    8. every artifact tool has `toolset: 'artifacts'` and `TOOLSETS.artifacts` exists; `toolByName('publish_artifact')` is defined.
  - Gate test: add a case where a tool with `outboundWhen: a => a.public === true` in a tainted run requests approval for `{public:true}` and runs freely for `{public:false}`. Copy the existing tainted-run outbound test's setup.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement** `outboundWhen` (types + ai-tools + judge rules + eval approval-tools), `html-warnings.ts`, `tools/artifacts.ts`, toolset entry, registration in `tools.ts` (after `...improvementTools`, with a `// ---- artifacts (cycle 86) ----` comment).
- [ ] **Step 4: Run** the tests + `pnpm typecheck` + the full `pnpm vitest run` — Expected: PASS (other tool-registry snapshot tests may need the new tools added — update them, don't delete assertions).
- [ ] **Step 5: Mutation check:** change the gate to ignore `outboundWhen`; confirm the new gate test goes red; restore via `git checkout` (commit first).
- [ ] **Step 6: Commit** — `git commit -m "feat(artifacts): agent tools, conditional outbound gate, artifacts toolset"` (stage the files listed above).

---

### Task 8: API routes and the vue-query composable

**Files:**
- Create: `server/api/artifacts/index.get.ts`, `server/api/artifacts/[id].get.ts`, `server/api/artifacts/[id].patch.ts`, `server/api/artifacts/[id].delete.ts`, `server/api/artifacts/[id]/view-url.get.ts`
- Create: `app/composables/useArtifacts.ts`
- Test: `test/artifacts-api.test.ts`

**Interfaces:**
- Consumes: service (Task 4), `signViewToken` (Task 3).
- Produces:
  - `GET /api/artifacts?project=<uuid>` → `ArtifactDTO[]`
  - `GET /api/artifacts/:id` → `ArtifactDetailDTO` (404 when missing)
  - `PATCH /api/artifacts/:id` body `{ title?, description?, slug?, isPublic?, projectId?, rollbackTo? }` (zod-validated) → `ArtifactDTO`; `ArtifactError` → 400 with `{ message }`
  - `DELETE /api/artifacts/:id` → `{ ok: true }`
  - `GET /api/artifacts/:id/view-url` → `{ url: string }` — public: `/artifact/<slug>/`; private: `/artifact/<slug>/~<token>/` (relative URLs). Session-only (`requireSession(event)`) — an API token never mints view tokens.
  - Composable: `useArtifactList(params?: MaybeRef<{ projectId?: string }>)` (key `['artifact','list',params]`), `useArtifactDetail(id: MaybeRef<string | undefined>)` (key `['artifact', id]`, `enabled: !!id`), `useArtifactViewUrl(id)` (key `['artifact', id, 'view-url']`, `staleTime: 10 * 60 * 1000`), and plain async `updateArtifact(id, patch)`, `removeArtifact(id)` using `$fetch`.
  - The service already calls `publishChange`; the API handlers must NOT emit again.

- [ ] **Step 1: Failing tests** — `test/artifacts-api.test.ts`: mock the service; assert PATCH validates (`isPublic: 'yes'` → 400), maps `ArtifactError` to 400 with the message, view-url returns a token URL for private and a plain URL for public, view-url refuses an api-token client (403), and the GET 404 path. Follow an existing API route test's harness.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS; `pnpm typecheck` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(artifacts): API routes and vue-query composable"`

---

### Task 9: UI — list page, detail page, chat card, nav

**Files:**
- Create: `app/lib/artifacts/display.ts` (+ `test/artifacts-display.test.ts`), `app/components/artifacts/Frame.vue`, `app/components/artifacts/ChatCard.vue`, `app/pages/artifacts/index.vue`, `app/pages/artifacts/[id].vue`
- Modify: `app/components/agent/ToolPart.vue`, `app/layouts/default.vue`

Before writing UI, load the `nuxt-ui` skill for `UTable`, `USwitch`, `UCard`, `UBadge`, `UButton`, `UDropdownMenu`, `UModal` APIs, and read `app/pages/gallery.vue` + one `app/pages/workstreams/*.vue` for page layout conventions (dashboard panel/navbar components used by other pages).

**Interfaces:**
- Consumes: Task 8 composable, `ArtifactDTO`/`ArtifactDetailDTO`.
- Produces:
  - `publishedArtifact(toolName: string, value: unknown): { id: string; slug: string; title: string; url: string; isPublic: boolean; version: number } | null` — non-null only for `publish_artifact`/`edit_artifact` results with `ok: true` and string `id`/`slug`/`url`.
  - `formatBytes(n: number): string` (`512 B`, `1.2 KB`, `3.4 MB`).
  - `<ArtifactsFrame :artifact-id :title class>` — fetches `useArtifactViewUrl`, renders `<iframe :src sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" referrerpolicy="no-referrer" loading="lazy">`; loading skeleton; error state text.
  - `<ArtifactsChatCard :id :slug :title :url :is-public :version>` — `UCard` with title, `UBadge` public/private, `v<N>`, a 360 px-tall `ArtifactsFrame`, and buttons "Open" (`:to="url"` `target="_blank"` `external`) and "Copy link" (clipboard + toast).

Steps:
- [ ] **Step 1: Failing unit test** `test/artifacts-display.test.ts` for `publishedArtifact` (ok result → object; `ok:false` → null; other tool name → null; missing fields → null) and `formatBytes`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement `display.ts`.** **Step 4: Run** — PASS.
- [ ] **Step 5: Components + pages.**
  - `index.vue`: page header "Artifacts"; `UTable` columns: Title (link to `/artifacts/<id>`), Slug (mono), Visibility (`USwitch` → `updateArtifact(id, { isPublic })`, toast on error), Versions, Size (`formatBytes`), Updated, actions (`UDropdownMenu`: Open, Copy link, Delete → confirm `UModal` → `removeArtifact`). Empty state: "No artifacts yet — ask Bridget to build something visual."
  - `[id].vue`: title + slug + visibility switch + Open/Copy; `ArtifactsFrame` (full width, `h-[70vh]`); edit form (title, description, slug) saving via `updateArtifact`, showing `ArtifactError` messages inline; version history list with "current" badge and "Roll back" buttons (`updateArtifact(id, { rollbackTo: v })`); links to project (`/projects/<slug>` — resolve via existing projects composable) and source conversation (`/agent?c=<conversationId>` — check the agent page's actual query param for opening a conversation).
  - `ToolPart.vue`: `const artifact = computed(() => (envelope.value ? publishedArtifact(props.part.toolName, envelope.value.value) : null))`; render `<ArtifactsChatCard v-if="artifact" v-bind="artifact" />` right after `WorkstreamsStartedCard`.
  - `default.vue`: add `{ label: 'Artifacts', icon: 'i-lucide-app-window', to: '/artifacts' }` after Gallery.
- [ ] **Step 6:** `pnpm typecheck` + `pnpm vitest run` — PASS.
- [ ] **Step 7: Browser-validate now (not later)** with `playwright-cli` per the browser-testing skill: seed one public and one private artifact (tiny `tsx` script with `initCore()` + `publishArtifact`), then: `/artifacts` lists both; flip a switch with a real click (`click <e-ref>`, not programmatic) and confirm it persists after reload; open the detail page and screenshot the iframe rendering the private artifact's HTML **and** its JS (fixture page writes "js ok" into the DOM from `./app.js`) **and** its `data/x.json` (fixture fetches it and renders a value). Save screenshots to the scratchpad.
- [ ] **Step 8: Commit** — `git commit -m "feat(artifacts): artifacts pages, sandboxed frame, chat card, nav"`

---

### Task 10: End-to-end proof, isolation proof, eval case

**Files:**
- Create: `test/fixtures/artifacts/isolation/index.html`, `test/fixtures/artifacts/vite-app/` (a minimal Vite + vanilla TS app with `base: './'`, two client routes using `history.pushState`, and `data/x.json`)
- Modify: `evals/bridget-core.json`
- Modify (if the skill lacks artifact recipes): `.claude/skills/browser-testing/SKILL.md` — add a short "Artifacts" section (seeding via `publishArtifact`, the private token redirect, the isolation fixture)

**Isolation fixture** (`index.html`) — writes each probe's outcome into `<pre id="out">`:

```html
<!doctype html><meta charset="utf-8"><title>isolation</title><pre id="out"></pre>
<script>
const out = []; const log = (k, v) => { out.push(k + '=' + v); document.getElementById('out').textContent = out.join('\n') }
try { log('cookie', JSON.stringify(document.cookie)) } catch (e) { log('cookie', 'threw') }
try { localStorage.setItem('x', '1'); log('localStorage', 'ok') } catch (e) { log('localStorage', 'threw') }
log('origin', String(self.origin))
fetch('/api/tasks', { credentials: 'include' })
  .then(r => log('api', 'status ' + r.status))
  .catch(() => log('api', 'blocked'))
</script>
```

- [ ] **Step 1: Isolation proof (playwright-cli).** Log in as the test user (the browser-testing skill has the account), publish the fixture privately, open `/artifact/<slug>/`, read `#out`. Expected: `cookie=""` (or `threw`), `localStorage=threw`, `origin=null`, `api=blocked` or `api=status 401` — **never** `status 200`. Record the output in the handover.
- [ ] **Step 2: Prove the test bites.** Temporarily change `ARTIFACT_CSP` to `''` (commit first), restart dev, re-run Step 1: `api` must become `status 200` and `localStorage=ok`. Restore with `git checkout`, restart, re-run Step 1 green. Record both outputs.
- [ ] **Step 3: Private-cookie finding (spec §5 "verify first").** Add a temporary `console.log('[artifact-cookie]', url.pathname, getHeader(event, 'cookie')?.includes('better-auth') ? 'cookie' : 'no-cookie')` to the route (uncommitted), open the private isolation fixture (which loads `./app.js`), read the dev server log, then remove the line. Record in the handover whether the subresource request (`app.js` / `data/x.json`) carried the better-auth session cookie. Either way the token stays (spec §5).
- [ ] **Step 4: Vite app published by the real agent.** Commit `test/fixtures/artifacts/vite-app/` **with a prebuilt `dist/`** (build it locally once with `pnpm dlx vite build` inside the fixture dir) so the test doesn't depend on sandbox network. Upload the fixture's `dist/` into a workspace via the workspace Files UI/API (or ask Bridget to write the files), then in `/agent` ask: "Publish vite-app/dist as an artifact called vite-demo with spa_fallback on." Expected: `publish_artifact` runs with `workspace_path`, the chat card shows the app in its iframe, `/artifact/vite-demo/settings` (a client route) serves the app, and the app renders a value from `data/x.json`. Then ask "update the vite-demo data so the value is 42" and confirm the version number did not change and the card/page shows 42 after reload.
- [ ] **Step 5: Logged-out checks.** New browser context: the public artifact renders; the private one redirects to `/login?redirect=…`; logging in lands back on the artifact (not the SPA 404).
- [ ] **Step 6: Eval case.** Append to `evals/bridget-core.json` `cases`:

```json
{
  "slug": "artifact-publish-chart",
  "prompt": "Make me a quick bar chart of these numbers as a page I can open: apples 3, pears 7, plums 5.",
  "expected_actions": [{ "tool": "publish_artifact" }],
  "forbidden_actions": [{ "tool": "delete_artifact" }],
  "expected_content": ["/artifact/"],
  "n_runs": 3,
  "max_steps": 10
}
```

  Run the suite's seed/validation unit tests (`pnpm vitest run packages/core/src/lib/eval/`) — PASS. Run this one case through the eval runner if the local dev rig supports it (`pnpm eval bridget-core` — check `package.json`); record the score. Note: the eval world needs `artifacts` reachable — the toolset is on-demand, so the case relies on auto-load; if it fails because Bridget never loads the toolset, improve the toolset description, not the case.
- [ ] **Step 7: Full gates** — `pnpm typecheck`, `pnpm vitest run`, the artifact DB tests, `pnpm build` — all PASS.
- [ ] **Step 8: Commit** — `git commit -m "test(artifacts): isolation proof fixtures, vite fixture, eval case"`

---

### Task 11: Docs, wiki mirror, MyMind task

**Files:**
- Create: `docs/wiki/artifacts.md`, `docs/handovers/2026-10-15-artifacts.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (cycle 86 row), `docs/BACKLOG.md` (spec §10 out-of-scope items as open entries), spec frontmatter `status: built`

- [ ] **Step 1: Wiki page** — match the frontmatter + structure of a recent wiki page (e.g. `docs/wiki/` page for workspaces/eval): status ladder `built`, tables + columns, the serving route and headers, the private token flow, tools + their gate classes, limits, the `data/` in-place rule, API endpoints, UI pages, known limits (no localStorage; Vite `base: './'`), and the isolation-proof result.
- [ ] **Step 2: Handover** — frontmatter matching existing handovers (cycle, date, status, branch, what shipped, what's deferred, verification evidence incl. the Task 10 outputs and the cookie finding, deploy notes: run migration 0089 in prod; `BETTER_AUTH_SECRET` already present; check Pangolin doesn't SSO-gate `/artifact/**`).
- [ ] **Step 3: Roadmap + backlog** updates.
- [ ] **Step 4: Mirror the wiki page to MyMind** using the `wiki-mirror` skill.
- [ ] **Step 5: Update the MyMind task** "Cycle 86 — Artifacts…" (id `848305ad-3666-4653-93e7-a91d37545c93`) checklist via `edit_task`.
- [ ] **Step 6: Commit** — `git commit -m "docs(artifacts): cycle 86 wiki, handover, roadmap"`
