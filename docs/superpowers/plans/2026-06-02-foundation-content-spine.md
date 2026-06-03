# Foundation + Content Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a manual-but-complete Postgres-backed Markdown document manager (browse path tree, edit/preview/split with autosave, frontmatter + promoted columns, keyword search, public-slug sharing) with dual auth, pgvector/storage/AI-provider seams ready for cycle 2.

**Architecture:** One Nuxt 4 service. Documents live in Postgres; all DB access for docs flows through a single `server/services/documents.ts` seam, exposed by thin Nitro routes and consumed by a `useDocuments()` composable. UI ports `command-center`'s split file-tree/editor (Nuxt UI v4 `UDashboardPanel`, CodeMirror 6, MDC). Auth via better-auth (session) + bearer API tokens (machine clients).

**Tech Stack:** Nuxt 4.4, Nuxt UI v4, Drizzle ORM + node-postgres, Postgres 16 + pgvector/pg_trgm/ltree, better-auth, CodeMirror 6, @nuxtjs/mdc, Vitest, playwright-cli.

**Reference sources on disk (read-only, copy/adapt from these):**
- `~/Documents/GitHub/bridget-services/command-center` — `app/pages/knowledge.vue`, `app/components/knowledge/{Tree,Editor}.vue`, `app/components/{CodeEditor.client,MdView}.vue`, `server/utils/knowledge-fs.ts`, `app/composables/useKnowledge.ts`, `app/layouts/default.vue`
- `~/Documents/GitHub/codethis-dev` — `server/db/index.ts`, `server/db/schema/documents.ts`, `shared/utils/languages.ts`
- `~/Documents/GitHub/copipasta` — `server/utils/storage/*`, `server/middleware/02.auth.ts`, better-auth setup

---

## Phase A — Foundation (app boots with DB + auth)

### Task A1: Install dependencies & test tooling

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add runtime + dev deps**

Run:
```bash
pnpm add drizzle-orm pg better-auth @nuxtjs/mdc zod nanoid \
  codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/language \
  @codemirror/lang-markdown @codemirror/lang-json @codemirror/lang-yaml @codemirror/lang-sql @codemirror/lang-javascript \
  @codemirror/theme-one-dark
pnpm add -D drizzle-kit @types/pg vitest @nuxt/test-utils happy-dom
```

- [ ] **Step 2: Add scripts to `package.json`**

```json
{
  "scripts": {
    "build": "nuxt build",
    "dev": "nuxt dev",
    "preview": "nuxt preview",
    "postinstall": "nuxt prepare",
    "lint": "eslint .",
    "typecheck": "nuxt typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

- [ ] **Step 3: Verify install**

Run: `pnpm typecheck`
Expected: PASS (no type errors from the bare scaffold).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add drizzle, better-auth, codemirror, mdc, vitest deps"
```

---

### Task A2: Local Postgres via Docker Compose

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `db/init/01-extensions.sql`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: mymind-db
    environment:
      POSTGRES_USER: mymind
      POSTGRES_PASSWORD: mymind
      POSTGRES_DB: mymind
    ports:
      - "5432:5432"
    volumes:
      - mymind-pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d
volumes:
  mymind-pgdata:
```

- [ ] **Step 2: Write `db/init/01-extensions.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 3: Write `.env.example`** (documents every env var; never commit a real `.env`)

```bash
# Database
DATABASE_URL=postgres://mymind:mymind@localhost:5432/mymind

# Auth
BETTER_AUTH_SECRET=change-me-32-bytes-min
BETTER_AUTH_URL=http://localhost:3000

# AI provider roles (OpenAI-spec). Unused in cycle 1; documented for cycle 2.
AI_REASONING_BASE_URL=
AI_REASONING_API_KEY=
AI_REASONING_MODEL=
AI_BULK_BASE_URL=http://192.168.2.25:8004/v1
AI_BULK_API_KEY=
AI_BULK_MODEL=qwen3.6-27b-coder
AI_EMBEDDINGS_BASE_URL=
AI_EMBEDDINGS_API_KEY=
AI_EMBEDDINGS_MODEL=qwen3-embedding-4b
AI_VISION_BASE_URL=http://192.168.2.25:8005/v1
AI_VISION_API_KEY=
AI_VISION_MODEL=qwen3-vl-8b
AI_STT_BASE_URL=http://192.168.2.25:8881/v1
AI_STT_API_KEY=
AI_TTS_BASE_URL=http://192.168.2.25:8880/v1
AI_TTS_API_KEY=

# Storage
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=./.data/uploads
# STORAGE_S3_* vars added in the image-hosting cycle
```

- [ ] **Step 4: Bring up the DB and verify extensions**

Run:
```bash
docker compose up -d db
sleep 3
docker exec mymind-db psql -U mymind -d mymind -c "\dx"
```
Expected: lists `pgcrypto`, `pg_trgm`, `ltree`, `vector`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml db/init/01-extensions.sql .env.example
git commit -m "chore: local postgres (pgvector) with required extensions"
```

---

### Task A3: Drizzle config + DB client

**Files:**
- Create: `drizzle.config.ts`
- Create: `server/db/index.ts`
- Create: `server/db/schema/index.ts` (re-export barrel)
- Create: `server/db/types/halfvec.ts`

- [ ] **Step 1: Write the custom `halfvec` column type** (`server/db/types/halfvec.ts`)

```ts
import { customType } from 'drizzle-orm/pg-core'

// Stored as pgvector halfvec(N). Read/written as number[]. Unused values stay null in cycle 1.
export const halfvec = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `halfvec(${dimensions})`
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(',').map(Number)
    }
  })('embedding')
```

- [ ] **Step 2: Write `server/db/index.ts`**

```ts
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle> | null = null

export function useDb() {
  if (_db) return _db
  const { databaseUrl } = useRuntimeConfig()
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  _db = drizzle(pool, { schema })
  return _db
}
```

- [ ] **Step 3: Write `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema/index.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! }
})
```

- [ ] **Step 4: Stub `server/db/schema/index.ts`**

```ts
// barrel — re-exports each schema module (filled by later tasks)
export {}
```

- [ ] **Step 5: Add `runtimeConfig` to `nuxt.config.ts`**

Add inside `defineNuxtConfig({ ... })`:
```ts
runtimeConfig: {
  databaseUrl: process.env.DATABASE_URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  betterAuthUrl: process.env.BETTER_AUTH_URL,
  storageDriver: process.env.STORAGE_DRIVER ?? 'local',
  storageLocalDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
  ai: {
    reasoning: { baseURL: process.env.AI_REASONING_BASE_URL, apiKey: process.env.AI_REASONING_API_KEY, model: process.env.AI_REASONING_MODEL },
    bulk: { baseURL: process.env.AI_BULK_BASE_URL, apiKey: process.env.AI_BULK_API_KEY, model: process.env.AI_BULK_MODEL },
    embeddings: { baseURL: process.env.AI_EMBEDDINGS_BASE_URL, apiKey: process.env.AI_EMBEDDINGS_API_KEY, model: process.env.AI_EMBEDDINGS_MODEL },
    vision: { baseURL: process.env.AI_VISION_BASE_URL, apiKey: process.env.AI_VISION_API_KEY, model: process.env.AI_VISION_MODEL },
    stt: { baseURL: process.env.AI_STT_BASE_URL, apiKey: process.env.AI_STT_API_KEY },
    tts: { baseURL: process.env.AI_TTS_BASE_URL, apiKey: process.env.AI_TTS_API_KEY }
  }
},
nitro: { experimental: { tasks: true } }
```

- [ ] **Step 6: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add drizzle.config.ts server/db nuxt.config.ts
git commit -m "feat(db): drizzle client, halfvec type, runtime config"
```

---

### Task A4: `projects` + `documents` schema

**Files:**
- Create: `server/db/schema/projects.ts`
- Create: `server/db/schema/documents.ts`
- Modify: `server/db/schema/index.ts`

- [ ] **Step 1: Write `server/db/schema/projects.ts`**

```ts
import { pgTable, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export type Project = typeof projects.$inferSelect
```

- [ ] **Step 2: Write `server/db/schema/documents.ts`**

```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  path: text('path').notNull(),
  title: text('title'),
  content: text('content').notNull().default(''),
  language: text('language').notNull().default('plaintext'),
  frontmatter: jsonb('frontmatter').notNull().default(sql`'{}'::jsonb`),
  project: text('project'),
  domain: text('domain'),
  type: text('type'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  topic: text('topic'), // ltree column; declared as text in drizzle, cast in queries
  contentHash: text('content_hash'),
  isPublic: boolean('is_public').notNull().default(false),
  publicSlug: text('public_slug'),
  embedding: halfvec(2560), // schema only in cycle 1; stays null
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (t) => ({
  pathUnique: uniqueIndex('documents_path_live_uidx').on(t.path).where(sql`${t.deletedAt} is null`),
  publicSlugUnique: uniqueIndex('documents_public_slug_uidx').on(t.publicSlug),
  tagsIdx: index('documents_tags_gin').using('gin', t.tags),
  projectIdx: index('documents_project_idx').on(t.project)
}))

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
```

- [ ] **Step 3: Update barrel `server/db/schema/index.ts`**

```ts
export * from './projects'
export * from './documents'
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `server/db/migrations/` containing `CREATE TABLE documents` and `CREATE TABLE projects`.

- [ ] **Step 5: Add trigram + topic indexes the generator can't express** — create `server/db/migrations/custom/0001-trgm-ltree.sql` and append its statements to the generated migration's bottom (or add as a follow-up SQL file run by `db:migrate`):

```sql
ALTER TABLE documents ALTER COLUMN topic TYPE ltree USING topic::ltree;
CREATE INDEX IF NOT EXISTS documents_topic_gist ON documents USING gist (topic);
CREATE INDEX IF NOT EXISTS documents_title_trgm ON documents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_content_trgm ON documents USING gin (content gin_trgm_ops);
```

Paste these four statements into the generated SQL migration file so `db:migrate` applies them.

- [ ] **Step 6: Apply and verify**

Run:
```bash
pnpm db:migrate
docker exec mymind-db psql -U mymind -d mymind -c "\d documents"
```
Expected: `documents` table with all columns; indexes `documents_title_trgm`, `documents_content_trgm`, `documents_topic_gist` present.

- [ ] **Step 7: Commit**

```bash
git add server/db
git commit -m "feat(db): documents + projects schema with trgm/ltree/vector indexes"
```

---

### Task A5: better-auth (session) + schema

**Files:**
- Create: `server/utils/auth.ts`
- Create: `server/api/auth/[...all].ts`
- Create: `server/db/schema/auth.ts`
- Modify: `server/db/schema/index.ts`

- [ ] **Step 1: Configure better-auth** (`server/utils/auth.ts`) — adapt from copipasta's auth setup

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { useDb } from '../db'

let _auth: ReturnType<typeof betterAuth> | null = null

export function useAuth() {
  if (_auth) return _auth
  const cfg = useRuntimeConfig()
  _auth = betterAuth({
    database: drizzleAdapter(useDb(), { provider: 'pg' }),
    secret: cfg.betterAuthSecret,
    baseURL: cfg.betterAuthUrl,
    emailAndPassword: { enabled: true }
  })
  return _auth
}
```

- [ ] **Step 2: Mount the handler** (`server/api/auth/[...all].ts`)

```ts
export default defineEventHandler((event) => {
  return useAuth().handler(toWebRequest(event))
})
```

- [ ] **Step 3: Generate better-auth's Drizzle schema**

Run: `pnpm dlx @better-auth/cli generate --config server/utils/auth.ts --output server/db/schema/auth.ts`
Expected: `auth.ts` with `user`, `session`, `account`, `verification` tables. Add `export * from './auth'` to the barrel.

- [ ] **Step 4: Migrate**

Run: `pnpm db:generate && pnpm db:migrate`
Expected: auth tables created.

- [ ] **Step 5: Verify sign-up works**

Run: `pnpm dev` in the background, then:
```bash
curl -s -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"tony@test.local","password":"test-password-123","name":"Tony"}'
```
Expected: JSON with a created user / session (not an error).

- [ ] **Step 6: Commit**

```bash
git add server/utils/auth.ts server/api/auth server/db/schema
git commit -m "feat(auth): better-auth session auth + drizzle schema"
```

---

### Task A6: API tokens + dual-auth middleware

**Files:**
- Create: `server/db/schema/api-tokens.ts`
- Create: `server/utils/api-token.ts`
- Test: `test/api-token.test.ts`
- Create: `server/middleware/auth.ts`
- Modify: `server/db/schema/index.ts`

- [ ] **Step 1: Write `api_tokens` schema** (`server/db/schema/api-tokens.ts`)

```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true })
})
export type ApiToken = typeof apiTokens.$inferSelect
```
Add `export * from './api-tokens'` to the barrel; run `pnpm db:generate && pnpm db:migrate`.

- [ ] **Step 2: Write the failing test** (`test/api-token.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { hashToken, generateToken } from '../server/utils/api-token'

describe('api-token', () => {
  it('generates a token and a stable sha256 hash', () => {
    const t = generateToken()
    expect(t).toMatch(/^mm_[A-Za-z0-9_-]{32,}$/)
    expect(hashToken(t)).toEqual(hashToken(t))
    expect(hashToken(t)).toHaveLength(64)
  })
  it('different tokens hash differently', () => {
    expect(hashToken(generateToken())).not.toEqual(hashToken(generateToken()))
  })
})
```

- [ ] **Step 3: Run it to confirm failure**

Run: `pnpm test -- api-token`
Expected: FAIL ("Cannot find module ../server/utils/api-token").

- [ ] **Step 4: Implement** (`server/utils/api-token.ts`)

```ts
import { createHash, randomBytes } from 'node:crypto'

export function generateToken(): string {
  return 'mm_' + randomBytes(24).toString('base64url')
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
```

- [ ] **Step 5: Run it to confirm pass**

Run: `pnpm test -- api-token`
Expected: PASS.

- [ ] **Step 6: Write the dual-auth middleware** (`server/middleware/auth.ts`)

```ts
import { eq, and, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { apiTokens } from '../db/schema'
import { hashToken } from '../utils/api-token'

const PUBLIC_PREFIXES = ['/api/auth', '/api/share']

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event).pathname
  if (!url.startsWith('/api')) return
  if (PUBLIC_PREFIXES.some(p => url.startsWith(p))) return

  // 1) bearer API token (machine clients)
  const authz = getHeader(event, 'authorization')
  if (authz?.startsWith('Bearer ')) {
    const db = useDb()
    const [row] = await db.select().from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hashToken(authz.slice(7))), isNull(apiTokens.revokedAt)))
      .limit(1)
    if (row) {
      event.context.client = { type: 'api-token', tokenId: row.id }
      db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).execute().catch(() => {})
      return
    }
  }

  // 2) session (web app)
  const session = await useAuth().api.getSession({ headers: event.headers })
  if (session?.user) {
    event.context.user = session.user
    event.context.client = { type: 'session', userId: session.user.id }
    return
  }

  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
})
```

- [ ] **Step 7: Commit**

```bash
git add server/db/schema/api-tokens.ts server/utils/api-token.ts test/api-token.test.ts server/middleware/auth.ts server/db/schema/index.ts server/db/migrations
git commit -m "feat(auth): api tokens + dual session/bearer middleware"
```

---

## Phase B — Document service + API (the seam)

### Task B1: Language detection util

**Files:**
- Create: `shared/utils/languages.ts` (port from `codethis-dev/shared/utils/languages.ts`)
- Test: `test/languages.test.ts`

- [ ] **Step 1: Write the failing test** (`test/languages.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { getLanguageFromPath } from '../shared/utils/languages'

describe('getLanguageFromPath', () => {
  it('maps known extensions', () => {
    expect(getLanguageFromPath('/input/notes.md')).toBe('markdown')
    expect(getLanguageFromPath('/x/data.json')).toBe('json')
    expect(getLanguageFromPath('/x/q.sql')).toBe('sql')
  })
  it('falls back to plaintext', () => {
    expect(getLanguageFromPath('/x/file.unknownext')).toBe('plaintext')
    expect(getLanguageFromPath('/x/noext')).toBe('plaintext')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- languages`
Expected: FAIL.

- [ ] **Step 3: Implement** — copy the `EXTENSION_TO_LANGUAGE` map from `codethis-dev/shared/utils/languages.ts`, then add:

```ts
export function getLanguageFromPath(path: string): string {
  const name = path.split('/').pop()!.toLowerCase()
  const lastDot = name.lastIndexOf('.')
  if (lastDot === -1) return 'plaintext'
  return EXTENSION_TO_LANGUAGE[name.slice(lastDot + 1)] ?? 'plaintext'
}
```
(Ensure `md`/`markdown` → `markdown` exists in the map.)

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test -- languages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/utils/languages.ts test/languages.test.ts
git commit -m "feat: path->language detection util"
```

---

### Task B2: Tree builder (pure function)

**Files:**
- Create: `server/services/tree.ts`
- Test: `test/tree.test.ts`

- [ ] **Step 1: Write the failing test** (`test/tree.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { buildTree } from '../server/services/tree'

describe('buildTree', () => {
  it('nests docs by path into folders', () => {
    const tree = buildTree([
      { id: '1', path: '/input/a.md', title: 'A' },
      { id: '2', path: '/projects/mymind/b.md', title: 'B' }
    ])
    expect(tree.map(n => n.name)).toEqual(['input', 'projects'])
    const projects = tree.find(n => n.name === 'projects')!
    expect(projects.type).toBe('folder')
    expect(projects.children![0].name).toBe('mymind')
    const b = projects.children![0].children![0]
    expect(b).toMatchObject({ type: 'file', name: 'b.md', id: '2' })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- tree`
Expected: FAIL.

- [ ] **Step 3: Implement** (`server/services/tree.ts`)

```ts
export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  id?: string
  title?: string | null
  children?: TreeNode[]
}
interface DocLite { id: string, path: string, title?: string | null }

export function buildTree(docs: DocLite[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'folder', children: [] }
  for (const doc of docs) {
    const parts = doc.path.split('/').filter(Boolean)
    let cur = root
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1
      const path = '/' + parts.slice(0, i + 1).join('/')
      let next = cur.children!.find(c => c.name === part)
      if (!next) {
        next = isFile
          ? { name: part, path, type: 'file', id: doc.id, title: doc.title }
          : { name: part, path, type: 'folder', children: [] }
        cur.children!.push(next)
      }
      cur = next
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
      .map(n => (n.children ? { ...n, children: sort(n.children) } : n))
  return sort(root.children!)
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test -- tree`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/tree.ts test/tree.test.ts
git commit -m "feat(docs): pure path->tree builder"
```

---

### Task B3: Document service (the DB seam)

**Files:**
- Create: `server/services/documents.ts`
- Create: `shared/types/documents.ts`

- [ ] **Step 1: Write shared DTO types** (`shared/types/documents.ts`)

```ts
export interface DocumentDTO {
  id: string
  path: string
  title: string | null
  content: string
  language: string
  frontmatter: Record<string, unknown>
  project: string | null
  domain: string | null
  type: string | null
  tags: string[]
  topic: string | null
  isPublic: boolean
  publicSlug: string | null
  updatedAt: string
}
export interface DocumentUpsert {
  path: string
  title?: string | null
  content?: string
  frontmatter?: Record<string, unknown>
  project?: string | null
  domain?: string | null
  type?: string | null
  tags?: string[]
  topic?: string | null
}
```

- [ ] **Step 2: Implement the service** (`server/services/documents.ts`)

```ts
import { and, eq, isNull, ilike, or, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { documents } from '../db/schema'
import { getLanguageFromPath } from '../../shared/utils/languages'
import { buildTree, type TreeNode } from './tree'
import type { DocumentDTO, DocumentUpsert } from '../../shared/types/documents'

const live = () => isNull(documents.deletedAt)
const toDTO = (r: typeof documents.$inferSelect): DocumentDTO => ({
  id: r.id, path: r.path, title: r.title, content: r.content, language: r.language,
  frontmatter: r.frontmatter as Record<string, unknown>, project: r.project, domain: r.domain,
  type: r.type, tags: r.tags, topic: r.topic, isPublic: r.isPublic, publicSlug: r.publicSlug,
  updatedAt: r.updatedAt.toISOString()
})

export async function listTree(): Promise<TreeNode[]> {
  const rows = await useDb().select({ id: documents.id, path: documents.path, title: documents.title })
    .from(documents).where(live())
  return buildTree(rows)
}

export async function getDoc(id: string): Promise<DocumentDTO | null> {
  const [r] = await useDb().select().from(documents).where(and(eq(documents.id, id), live())).limit(1)
  return r ? toDTO(r) : null
}

export async function createDoc(input: DocumentUpsert): Promise<DocumentDTO> {
  const [r] = await useDb().insert(documents).values({
    path: input.path, title: input.title ?? input.path.split('/').pop() ?? null,
    content: input.content ?? '', language: getLanguageFromPath(input.path),
    frontmatter: input.frontmatter ?? {}, project: input.project, domain: input.domain,
    type: input.type, tags: input.tags ?? [], topic: input.topic,
    contentHash: createHash('sha256').update(input.content ?? '').digest('hex')
  }).returning()
  return toDTO(r)
}

export async function updateDoc(id: string, input: Partial<DocumentUpsert>): Promise<DocumentDTO | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  for (const k of ['title', 'content', 'frontmatter', 'project', 'domain', 'type', 'tags', 'topic', 'path'] as const) {
    if (input[k] !== undefined) patch[k] = input[k]
  }
  if (input.path !== undefined) patch.language = getLanguageFromPath(input.path)
  if (input.content !== undefined) patch.contentHash = createHash('sha256').update(input.content).digest('hex')
  const [r] = await useDb().update(documents).set(patch).where(and(eq(documents.id, id), live())).returning()
  return r ? toDTO(r) : null
}

export async function moveDoc(id: string, newPath: string) { return updateDoc(id, { path: newPath }) }

export async function deleteDoc(id: string): Promise<boolean> {
  const [r] = await useDb().update(documents).set({ deletedAt: new Date() })
    .where(and(eq(documents.id, id), live())).returning({ id: documents.id })
  return !!r
}

export async function searchDocs(q: string): Promise<DocumentDTO[]> {
  const rows = await useDb().select().from(documents)
    .where(and(live(), or(ilike(documents.title, `%${q}%`), ilike(documents.content, `%${q}%`))))
    .orderBy(sql`similarity(coalesce(${documents.title},'') || ' ' || ${documents.content}, ${q}) desc`)
    .limit(50)
  return rows.map(toDTO)
}

export async function setPublic(id: string, isPublic: boolean): Promise<DocumentDTO | null> {
  const slug = isPublic ? nanoid(12) : null
  const [r] = await useDb().update(documents)
    .set({ isPublic, publicSlug: isPublic ? sql`coalesce(${documents.publicSlug}, ${slug})` : null, updatedAt: new Date() })
    .where(and(eq(documents.id, id), live())).returning()
  return r ? toDTO(r) : null
}

export async function getByPublicSlug(slug: string): Promise<DocumentDTO | null> {
  const [r] = await useDb().select().from(documents)
    .where(and(eq(documents.publicSlug, slug), eq(documents.isPublic, true), live())).limit(1)
  return r ? toDTO(r) : null
}
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/documents.ts shared/types/documents.ts
git commit -m "feat(docs): document service (the DB seam)"
```

---

### Task B4: Document API routes

**Files:**
- Create: `server/api/documents/tree.get.ts`
- Create: `server/api/documents/index.post.ts`
- Create: `server/api/documents/[id].get.ts`
- Create: `server/api/documents/[id].put.ts`
- Create: `server/api/documents/[id].delete.ts`
- Create: `server/api/documents/[id]/move.post.ts`
- Create: `server/api/documents/[id]/share.post.ts`
- Create: `server/api/documents/search.get.ts`
- Create: `server/api/share/[slug].get.ts`

- [ ] **Step 1: Write each route** (thin wrappers around the service; `validatedBody` via zod)

`tree.get.ts`:
```ts
import { listTree } from '../../services/documents'
export default defineEventHandler(() => listTree())
```

`index.post.ts`:
```ts
import { z } from 'zod'
import { createDoc } from '../../services/documents'
const Body = z.object({
  path: z.string().min(1).regex(/^\//, 'path must start with /'),
  title: z.string().nullish(), content: z.string().optional(),
  frontmatter: z.record(z.unknown()).optional(),
  project: z.string().nullish(), domain: z.string().nullish(), type: z.string().nullish(),
  tags: z.array(z.string()).optional(), topic: z.string().nullish()
})
export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  return createDoc(body)
})
```

`[id].get.ts`:
```ts
import { getDoc } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const doc = await getDoc(getRouterParam(event, 'id')!)
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
```

`[id].put.ts`:
```ts
import { z } from 'zod'
import { updateDoc } from '../../services/documents'
const Body = z.object({
  path: z.string().optional(), title: z.string().nullish(), content: z.string().optional(),
  frontmatter: z.record(z.unknown()).optional(), project: z.string().nullish(),
  domain: z.string().nullish(), type: z.string().nullish(), tags: z.array(z.string()).optional(),
  topic: z.string().nullish()
})
export default defineEventHandler(async (event) => {
  const doc = await updateDoc(getRouterParam(event, 'id')!, Body.parse(await readBody(event)))
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
```

`[id].delete.ts`:
```ts
import { deleteDoc } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const ok = await deleteDoc(getRouterParam(event, 'id')!)
  if (!ok) throw createError({ statusCode: 404 })
  return { ok: true }
})
```

`[id]/move.post.ts`:
```ts
import { z } from 'zod'
import { moveDoc } from '../../../services/documents'
export default defineEventHandler(async (event) => {
  const { path } = z.object({ path: z.string().regex(/^\//) }).parse(await readBody(event))
  const doc = await moveDoc(getRouterParam(event, 'id')!, path)
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
```

`[id]/share.post.ts`:
```ts
import { z } from 'zod'
import { setPublic } from '../../../services/documents'
export default defineEventHandler(async (event) => {
  const { isPublic } = z.object({ isPublic: z.boolean() }).parse(await readBody(event))
  const doc = await setPublic(getRouterParam(event, 'id')!, isPublic)
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
```

`search.get.ts`:
```ts
import { searchDocs } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  if (typeof q !== 'string' || !q.trim()) return []
  return searchDocs(q.trim())
})
```

`../share/[slug].get.ts` (public, auth-exempt via middleware prefix):
```ts
import { getByPublicSlug } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const doc = await getByPublicSlug(getRouterParam(event, 'slug')!)
  if (!doc) throw createError({ statusCode: 404 })
  return { path: doc.path, title: doc.title, content: doc.content, language: doc.language, updatedAt: doc.updatedAt }
})
```

- [ ] **Step 2: Smoke test the routes end-to-end** (dev server running, signed-in cookie jar)

Run:
```bash
# create
curl -s -b cookies.txt -X POST localhost:3000/api/documents -H 'content-type: application/json' \
  -d '{"path":"/input/hello.md","content":"# Hello\n\nworld"}' | tee /tmp/doc.json
ID=$(jq -r .id /tmp/doc.json)
# tree, get, search
curl -s -b cookies.txt localhost:3000/api/documents/tree | jq '.[0].name'   # "input"
curl -s -b cookies.txt localhost:3000/api/documents/$ID | jq '.language'    # "markdown"
curl -s -b cookies.txt "localhost:3000/api/documents/search?q=world" | jq 'length'  # >=1
# share
curl -s -b cookies.txt -X POST localhost:3000/api/documents/$ID/share -H 'content-type: application/json' -d '{"isPublic":true}' | jq -r .publicSlug
```
Expected: outputs shown in comments; the public slug then resolves at `/api/share/<slug>` without cookies.

- [ ] **Step 3: Commit**

```bash
git add server/api/documents server/api/share
git commit -m "feat(docs): document + public-share API routes"
```

---

### Task B5: `useDocuments` composable

**Files:**
- Create: `app/composables/useDocuments.ts` (port shape from `command-center/app/composables/useKnowledge.ts`)

- [ ] **Step 1: Implement**

```ts
import type { DocumentDTO } from '~~/shared/types/documents'
import type { TreeNode } from '~~/server/services/tree'

export function useDocuments() {
  const tree = () => $fetch<TreeNode[]>('/api/documents/tree')
  const get = (id: string) => $fetch<DocumentDTO>(`/api/documents/${id}`)
  const create = (body: Partial<DocumentDTO> & { path: string }) => $fetch<DocumentDTO>('/api/documents', { method: 'POST', body })
  const update = (id: string, body: Partial<DocumentDTO>) => $fetch<DocumentDTO>(`/api/documents/${id}`, { method: 'PUT', body })
  const remove = (id: string) => $fetch(`/api/documents/${id}`, { method: 'DELETE' })
  const move = (id: string, path: string) => $fetch<DocumentDTO>(`/api/documents/${id}/move`, { method: 'POST', body: { path } })
  const share = (id: string, isPublic: boolean) => $fetch<DocumentDTO>(`/api/documents/${id}/share`, { method: 'POST', body: { isPublic } })
  const search = (q: string) => $fetch<DocumentDTO[]>('/api/documents/search', { query: { q } })
  return { tree, get, create, update, remove, move, share, search }
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/composables/useDocuments.ts
git commit -m "feat(docs): useDocuments client composable"
```

---

## Phase C — UI (browse + edit)

### Task C1: Storage abstraction (port copipasta)

**Files:**
- Create: `server/utils/storage/index.ts`, `local.ts`, `s3.ts` (copy from `copipasta/server/utils/storage/*`)

- [ ] **Step 1: Copy the three files** from `~/Documents/GitHub/copipasta/server/utils/storage/` and adapt config reads to `useRuntimeConfig()` (`storageDriver`, `storageLocalDir`). Leave S3 driver present but unconfigured (the image cycle wires it).

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/utils/storage
git commit -m "feat: storage abstraction (local default, s3 stub) ported from copipasta"
```

---

### Task C2: Editor primitives (port command-center)

**Files:**
- Create: `app/components/CodeEditor.client.vue` (copy from `command-center/app/components/CodeEditor.client.vue`)
- Create: `app/components/MdView.vue` (copy from `command-center/app/components/MdView.vue`)
- Modify: `nuxt.config.ts` (add `@nuxtjs/mdc` to `modules`)

- [ ] **Step 1: Add MDC module** — in `nuxt.config.ts` `modules: ['@nuxt/eslint', '@nuxt/ui', '@nuxtjs/mdc']`.

- [ ] **Step 2: Copy `CodeEditor.client.vue`** verbatim; confirm its imported CodeMirror language packages match those installed in A1 (markdown/json/yaml/sql/javascript). Remove any languages not installed.

- [ ] **Step 3: Copy `MdView.vue`** verbatim (it wraps `<MDC :value="source" />`).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (build confirms client-only component + MDC resolve).

- [ ] **Step 5: Commit**

```bash
git add app/components/CodeEditor.client.vue app/components/MdView.vue nuxt.config.ts
git commit -m "feat(ui): CodeMirror editor + MDC view ported from command-center"
```

---

### Task C3: Documents page — split tree/editor

**Files:**
- Create: `app/pages/documents.vue` (adapt from `command-center/app/pages/knowledge.vue`)
- Create: `app/components/documents/Tree.vue` (adapt from `command-center/app/components/knowledge/Tree.vue`)
- Create: `app/components/documents/Editor.vue` (adapt from `command-center/app/components/knowledge/Editor.vue`)
- Modify: `app/app.vue` / layout for sidebar nav

- [ ] **Step 1: Adapt `Tree.vue`** — replace all `useKnowledge()` calls with `useDocuments()`; nodes now carry `id` (file nodes) instead of `rel` paths. Selecting a file emits its `id`. Create/rename/move/delete call the composable's `create`/`update`/`move`/`remove`. New-file flow asks for a path (default under the selected folder, e.g. `/input/untitled.md`).

- [ ] **Step 2: Adapt `Editor.vue`** — props: `documentId`. On change of `documentId`, `get(id)` to load; bind `content` to `CodeEditor`; keep the `edit|preview|split` cookie toggle and debounced (1.5s) autosave calling `update(id, { content, frontmatter, ... })`; show save-status badge. Add a small frontmatter/metadata form (path, title, project, domain, type, tags) that persists via `update`.

- [ ] **Step 3: Adapt `documents.vue`** — `UDashboardPanel` left (Tree, `resizable`, `default-size=18`) + right (`Editor`, `grow`); track `selectedId`; a search box in the left header calling `search(q)` and listing results (clicking a result selects its id).

- [ ] **Step 4: Add sidebar nav** — a `UDashboardSidebar` + `UNavigationMenu` with a "Documents" item routing to `/documents` (adapt from `command-center/app/layouts/default.vue`). Make `/documents` the post-login landing route.

- [ ] **Step 5: Build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/pages/documents.vue app/components/documents app/app.vue app/layouts
git commit -m "feat(ui): split document browser + editor page"
```

---

### Task C4: Public share page

**Files:**
- Create: `app/pages/share/[slug].vue`

- [ ] **Step 1: Implement** (no auth; read-only)

```vue
<script setup lang="ts">
const slug = useRoute().params.slug as string
const { data, error } = await useFetch(`/api/share/${slug}`)
if (error.value) throw createError({ statusCode: 404, fatal: true })
</script>
<template>
  <div class="max-w-3xl mx-auto p-6">
    <h1 class="text-xl font-semibold mb-4">{{ data?.title }}</h1>
    <MdView v-if="data?.language === 'markdown'" :source="data.content" />
    <pre v-else class="whitespace-pre-wrap text-sm">{{ data?.content }}</pre>
  </div>
</template>
```

- [ ] **Step 2: Ensure `/share` and `/api/share` are unauthenticated** — `app/middleware`/route rules must not gate `/share/**`; the server middleware already exempts `/api/share`. Add to `nuxt.config.ts` `routeRules` if needed: `'/share/**': { ssr: true }`.

- [ ] **Step 3: Build & commit**

```bash
pnpm typecheck && pnpm build
git add app/pages/share nuxt.config.ts
git commit -m "feat(docs): public read-only share page"
```

---

## Phase D — AI provider scaffold + validation

### Task D1: AI provider factory (scaffold, unused)

**Files:**
- Create: `server/lib/ai/provider.ts`
- Test: `test/provider.test.ts`

- [ ] **Step 1: Write the failing test** (`test/provider.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({
  ai: { reasoning: { baseURL: 'http://x/v1', apiKey: 'k', model: 'm' }, embeddings: { baseURL: '', apiKey: '', model: 'e' } }
}))

describe('aiProvider', () => {
  it('returns config for a configured role', async () => {
    const { aiProvider } = await import('../server/lib/ai/provider')
    expect(aiProvider('reasoning').model).toBe('m')
  })
  it('throws for an unconfigured role when required', async () => {
    const { aiProvider } = await import('../server/lib/ai/provider')
    expect(() => aiProvider('embeddings', { required: true })).toThrow()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- provider`
Expected: FAIL.

- [ ] **Step 3: Implement** (`server/lib/ai/provider.ts`)

```ts
export type AiRole = 'reasoning' | 'bulk' | 'embeddings' | 'vision' | 'stt' | 'tts'
export interface AiClient { baseURL?: string, apiKey?: string, model?: string }

// OpenAI-spec endpoint config per role, env-driven. Cycle 2 adds the actual chat/embed calls.
export function aiProvider(role: AiRole, opts: { required?: boolean } = {}): AiClient {
  const cfg = (useRuntimeConfig().ai as Record<AiRole, AiClient>)[role] ?? {}
  if (opts.required && !cfg.baseURL) {
    throw new Error(`AI role "${role}" is not configured (set AI_${role.toUpperCase()}_BASE_URL)`)
  }
  return cfg
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test -- provider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/ai/provider.ts test/provider.test.ts
git commit -m "feat(ai): env-configured OpenAI-spec provider factory (scaffold)"
```

---

### Task D2: End-to-end validation with playwright-cli

**Files:**
- Create: `docs/handovers/2026-06-02-foundation-content-spine.md`

- [ ] **Step 1: Full-stack up**

Run: `docker compose up -d db && pnpm db:migrate && pnpm dev` (dev in background).

- [ ] **Step 2: Drive the happy path with `playwright-cli`** (NOT MCP, per project rule). Script the flow:
  1. Sign up / sign in a test account.
  2. Navigate to `/documents`; create `/input/test.md` with `# Test\n\nhello spine`.
  3. Toggle edit → split → preview; confirm preview renders the heading.
  4. Set project=`mymind`, tags=`spine,test`; reload; confirm persisted.
  5. Search "hello"; confirm the doc appears.
  6. Toggle public; copy the share slug; open `/share/<slug>` in a fresh (logged-out) context; confirm content renders.

Expected: every step passes; capture a screenshot of the split view.

- [ ] **Step 3: API-token path**

Create a token row (via the settings UI if built, else insert through a temporary script), then:
```bash
curl -s -H "Authorization: Bearer <token>" localhost:3000/api/documents/tree | jq 'length'   # >=1
curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/documents/tree                       # 401 (no token)
```
Expected: `>=1` with token; `401` without.

- [ ] **Step 4: Gate checks**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Write the handover** — fill `docs/handovers/2026-06-02-foundation-content-spine.md` with accurate frontmatter (`status: shipped`, `shipped:`, `deferred:`, `next_seam: cycle 2 — embedding worker fills documents.embedding; add HNSW index + semantic/RRF search on the existing search surface`). Bump wiki `document-spine.md` / `auth.md` / `ai-providers.md` to `status: shipped` with the real schema/routes/env vars. Flip the roadmap cycle-1 row to `shipped` and link this plan + handover.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: cycle-1 handover; wiki + roadmap to shipped"
```

---

## Self-Review

**Spec coverage:** app shell + dual auth (A5/A6) ✓ · Drizzle/pg/pgvector (A2–A4) ✓ · storage abstraction (C1) ✓ · documents data model incl. promoted columns + halfvec placeholder (A4) ✓ · path-tree browser + CodeMirror/MDC edit/preview/split + autosave (C2/C3) ✓ · manual frontmatter (C3 step 2) ✓ · `/input` staging (path convention, exercised in D2) ✓ · public-slug sharing (B3/B4/C4) ✓ · trigram search (A4 indexes + B3 `searchDocs` + B4 route + C3 search box) ✓ · env OpenAI-spec provider scaffold (A3 config + D1) ✓ · validation (D2) ✓ · wiki/handover/roadmap updates (D2 step 5) ✓.

**Placeholder scan:** no "TBD/TODO"; UI port tasks name exact source files + the specific adaptation (compose-swap, id-vs-rel, autosave) rather than deferring. S3 driver intentionally left as a stub for the image cycle (called out, not a gap).

**Type consistency:** `DocumentDTO`/`DocumentUpsert` (B3) used consistently by routes (B4) and composable (B5); `TreeNode` defined in B2 reused in B3/B5; `aiProvider(role)` signature consistent A3-config ↔ D1. `getLanguageFromPath` named identically across B1/B3.

**Known seams left for cycle 2 (intentional):** `documents.embedding` stays null; no HNSW index yet (added when embeddings are populated to avoid an empty-index migration); `aiProvider` returns config but performs no calls.
