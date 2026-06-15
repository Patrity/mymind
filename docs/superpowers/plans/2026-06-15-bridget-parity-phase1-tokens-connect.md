# Phase 1 — API Keys + Connect to Claude Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a settings UI to mint/list/revoke API tokens plus a copy-paste "Connect to Claude Code" helper (MCP config + a hook installer script) so a fresh token immediately starts ingesting sessions.

**Architecture:** A `last_four` display-hint column is added to the existing `api_tokens` table. A thin `api-tokens` service (mint/list/revoke, soft-revoke) is fronted by three **session-only** endpoints under `/api/settings/tokens`. A versioned `cc-hook.sh` script is served (unauthenticated, non-secret) from `/api/setup/cc-hook`. The settings page gains a 5th tab rendering the token list, a create modal (plaintext shown once), and three secret-free Connect snippets (token via env vars, MCP `.mcp.json`, hooks `settings.json`). Live across tabs via the existing SSE + vue-query convention.

**Tech Stack:** Nuxt 4 (SPA app + Nitro server), Drizzle ORM + Postgres, `@tanstack/vue-query`, Nuxt UI v4, vitest, better-auth (session) + bearer API tokens.

**Scope:** This is **Phase 1 of 5** of the cycle-13 bridget-parity spec (`docs/superpowers/specs/2026-06-15-bridget-parity-design.md`), covering spec **Part A** (API key management) + **Part B** (Connect to Claude Code). Phases 2–5 (capture fidelity, migration, summaries/search, enrichment + memory intelligence) get their own plans. This phase produces working, shippable software on its own.

**Branch:** `feat/bridget-parity` (already created; the spec is committed there).

**Conventions to honor (verified in-repo):**
- Tests are pure-function vitest specs in `test/*.test.ts` (no DB). DB functions are validated by the E2E gate, not unit tests.
- Composables use `ofetch` + `@tanstack/vue-query`; list query keys are `[resource, 'list', …]`.
- `.vue` files use Nuxt UI v4 components + semantic color tokens only (`text-muted`, `border-default`, `color="primary"`, etc.) — never raw Tailwind palette. Invoke the `nuxt-ui-docs` skill before using a component you're unsure of.
- Every server mutation calls `publishChange({ resource, action, id })`; `resource` must be in the `ResourceName` union.
- Validate UI with `playwright-cli` (never the Playwright MCP).

---

## File structure

**Create:**
- `test/api-token.test.ts` — unit tests for token pure helpers.
- `test/auth-guard.test.ts` — unit test for the session-client predicate.
- `server/utils/auth-guard.ts` — `isSessionClient()` + `requireSession(event)`.
- `shared/types/api-token.ts` — the `ApiTokenDTO` shape (shared by server + client, matching `shared/types/memory.ts`).
- `server/services/api-tokens.ts` — `listTokens` / `createToken` / `revokeToken`.
- `server/api/settings/tokens/index.get.ts` — list.
- `server/api/settings/tokens/index.post.ts` — create (returns plaintext once).
- `server/api/settings/tokens/[id]/revoke.post.ts` — soft-revoke.
- `server/assets/setup/cc-hook.sh` — the hook client, a real bash file (single source of truth; served as a Nitro server asset).
- `server/api/setup/cc-hook.get.ts` — serves the script (public).
- `app/composables/useApiTokens.ts` — vue-query reads + mutation fetchers.
- `app/components/settings/ApiKeysTab.vue` — the tab UI (list + create + Connect).

**Modify:**
- `server/utils/api-token.ts` — add `tokenLastFour()`.
- `server/db/schema/api-tokens.ts` — add `lastFour` column.
- `server/middleware/auth.ts` — add `/api/setup` to `PUBLIC_PREFIXES`.
- `nuxt.config.ts` — register the `setup` Nitro server asset.
- `shared/types/live.ts` — add `'apiToken'` to `ResourceName`.
- `app/pages/settings.vue` — register the 5th tab.

**Generated (do not hand-edit):** `server/db/migrations/0015_*.sql` + `server/db/migrations/meta/*` via `pnpm db:generate`.

---

## Task 1: `api_tokens.last_four` column + token helpers

**Files:**
- Modify: `server/utils/api-token.ts`
- Modify: `server/db/schema/api-tokens.ts`
- Create: `test/api-token.test.ts`
- Generated: `server/db/migrations/0015_*.sql`

- [ ] **Step 1: Write the failing test**

Create `test/api-token.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { generateToken, hashToken, tokenLastFour } from '../server/utils/api-token'

describe('generateToken', () => {
  it('produces an mm_-prefixed token', () => {
    const t = generateToken()
    expect(t.startsWith('mm_')).toBe(true)
    expect(t.length).toBeGreaterThan(20)
  })

  it('produces a unique token each call', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('hashToken', () => {
  it('is deterministic and 64 hex chars (sha256)', () => {
    const h = hashToken('mm_abc')
    expect(h).toBe(hashToken('mm_abc'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different inputs', () => {
    expect(hashToken('mm_a')).not.toBe(hashToken('mm_b'))
  })
})

describe('tokenLastFour', () => {
  it('returns the last 4 characters', () => {
    expect(tokenLastFour('mm_abcdEFGH')).toBe('EFGH')
  })

  it('returns the whole string when shorter than 4', () => {
    expect(tokenLastFour('ab')).toBe('ab')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- api-token`
Expected: FAIL — `tokenLastFour` is not exported.

- [ ] **Step 3: Add the helper**

Append to `server/utils/api-token.ts`:

```typescript
/** Non-secret display hint: the last 4 chars of a minted token (for `mm_…AbCd`). */
export function tokenLastFour(token: string): string {
  return token.slice(-4)
}
```

- [ ] **Step 4: Add the schema column**

In `server/db/schema/api-tokens.ts`, add the `lastFour` field after `tokenHash`:

```typescript
export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastFour: text('last_four'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true })
})
```

- [ ] **Step 5: Generate + apply the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/0015_*.sql` containing `ALTER TABLE "api_tokens" ADD COLUMN "last_four" text;` plus a meta snapshot.

Run: `pnpm db:migrate`
Expected: migration applies cleanly to the local DB.

- [ ] **Step 6: Run the tests + typecheck**

Run: `pnpm test -- api-token`
Expected: PASS.
Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add server/utils/api-token.ts server/db/schema/api-tokens.ts server/db/migrations test/api-token.test.ts
git commit -m "feat(tokens): add last_four display-hint column + tokenLastFour helper"
```

---

## Task 2: `requireSession` guard

**Files:**
- Create: `server/utils/auth-guard.ts`
- Create: `test/auth-guard.test.ts`

Context: `server/middleware/auth.ts` sets `event.context.client = { type: 'session', userId }` for web users and `{ type: 'api-token', tokenId }` for bearer clients. Token-management endpoints must reject `api-token` clients.

- [ ] **Step 1: Write the failing test**

Create `test/auth-guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { isSessionClient } from '../server/utils/auth-guard'

describe('isSessionClient', () => {
  it('is true for a session client', () => {
    expect(isSessionClient({ type: 'session', userId: 'u1' })).toBe(true)
  })

  it('is false for an api-token client', () => {
    expect(isSessionClient({ type: 'api-token', tokenId: 't1' })).toBe(false)
  })

  it('is false when client is missing', () => {
    expect(isSessionClient(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- auth-guard`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

Create `server/utils/auth-guard.ts`:

```typescript
import type { H3Event } from 'h3'

export interface ClientContext {
  type?: 'session' | 'api-token'
  userId?: string
  tokenId?: string
}

/** Pure predicate: true only for an authenticated web-session client. */
export function isSessionClient(client: ClientContext | undefined): boolean {
  return client?.type === 'session'
}

/**
 * Throw 403 unless the caller is a web session. Use on sensitive endpoints
 * (token management) so a leaked machine token can't escalate.
 */
export function requireSession(event: H3Event): void {
  const client = event.context.client as ClientContext | undefined
  if (!isSessionClient(client)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden: session required' })
  }
}
```

Note: `createError` is a Nitro/h3 auto-import (no import needed), consistent with `server/middleware/auth.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- auth-guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/auth-guard.ts test/auth-guard.test.ts
git commit -m "feat(auth): add requireSession guard for sensitive endpoints"
```

---

## Task 3: `apiToken` live resource + api-tokens service

**Files:**
- Modify: `shared/types/live.ts`
- Create: `server/services/api-tokens.ts`

- [ ] **Step 1: Register the live resource**

In `shared/types/live.ts`, add `'apiToken'` to the union:

```typescript
export type ResourceName =
  | 'document'
  | 'image'
  | 'memory'
  | 'review'
  | 'project'
  | 'task'
  | 'session'
  | 'clipboard'
  | 'activity'
  | 'apiToken'
```

No `live-dispatch.ts` change needed: the default path invalidates `['apiToken', 'list']` and `['apiToken', id]`.

- [ ] **Step 2: Define the shared DTO type**

Create `shared/types/api-token.ts`:

```typescript
export interface ApiTokenDTO {
  id: string
  name: string
  lastFour: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}
```

- [ ] **Step 3: Implement the service**

Create `server/services/api-tokens.ts`:

```typescript
import { desc, eq, isNull, and } from 'drizzle-orm'
import { useDb } from '../db'
import { apiTokens } from '../db/schema'
import { generateToken, hashToken, tokenLastFour } from '../utils/api-token'
import { publishChange } from '../utils/live-bus'
import type { ApiTokenDTO } from '../../shared/types/api-token'

function toDTO(r: typeof apiTokens.$inferSelect): ApiTokenDTO {
  return {
    id: r.id,
    name: r.name,
    lastFour: r.lastFour,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null
  }
}

/** All tokens, newest first. Never returns the hash. */
export async function listTokens(): Promise<ApiTokenDTO[]> {
  const rows = await useDb().select().from(apiTokens).orderBy(desc(apiTokens.createdAt))
  return rows.map(toDTO)
}

/**
 * Mint a token. Returns the DTO plus the plaintext token EXACTLY ONCE —
 * the plaintext is never persisted or logged (only its sha256 hash + last 4).
 */
export async function createToken(name: string): Promise<ApiTokenDTO & { token: string }> {
  const trimmed = name.trim()
  if (!trimmed) {
    throw createError({ statusCode: 400, statusMessage: 'Token name is required' })
  }
  const token = generateToken()
  const [row] = await useDb().insert(apiTokens).values({
    name: trimmed,
    tokenHash: hashToken(token),
    lastFour: tokenLastFour(token)
  }).returning()
  publishChange({ resource: 'apiToken', action: 'created', id: row!.id })
  return { ...toDTO(row!), token }
}

/** Soft-revoke (set revoked_at, keep the row). Idempotent; 404 on unknown id. */
export async function revokeToken(id: string): Promise<ApiTokenDTO> {
  const db = useDb()
  const [existing] = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1)
  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Token not found' })
  }
  if (existing.revokedAt) {
    return toDTO(existing) // already revoked — idempotent
  }
  const [row] = await db.update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning()
  publishChange({ resource: 'apiToken', action: 'updated', id })
  return toDTO(row ?? existing)
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add shared/types/live.ts shared/types/api-token.ts server/services/api-tokens.ts
git commit -m "feat(tokens): api-tokens service (list/mint/revoke) + apiToken live resource"
```

---

## Task 4: Token management endpoints (session-only)

**Files:**
- Create: `server/api/settings/tokens/index.get.ts`
- Create: `server/api/settings/tokens/index.post.ts`
- Create: `server/api/settings/tokens/[id]/revoke.post.ts`

- [ ] **Step 1: List endpoint**

Create `server/api/settings/tokens/index.get.ts`:

```typescript
import { requireSession } from '../../../utils/auth-guard'
import { listTokens } from '../../../services/api-tokens'

export default defineEventHandler(async (event) => {
  requireSession(event)
  return listTokens()
})
```

- [ ] **Step 2: Create endpoint**

Create `server/api/settings/tokens/index.post.ts`:

```typescript
import { z } from 'zod'
import { requireSession } from '../../../utils/auth-guard'
import { createToken } from '../../../services/api-tokens'

const Body = z.object({ name: z.string().min(1).max(100) })

export default defineEventHandler(async (event) => {
  requireSession(event)
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  return createToken(parsed.data.name)
})
```

- [ ] **Step 3: Revoke endpoint**

Create `server/api/settings/tokens/[id]/revoke.post.ts`:

```typescript
import { requireSession } from '../../../../utils/auth-guard'
import { revokeToken } from '../../../../services/api-tokens'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  return revokeToken(id)
})
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. (Verify the relative import depth: `[id]/revoke.post.ts` is four levels under `server/`, hence `../../../../utils`.)

- [ ] **Step 5: Commit**

```bash
git add server/api/settings/tokens
git commit -m "feat(tokens): session-only list/create/revoke endpoints"
```

---

## Task 5: Serve the `cc-hook.sh` installer (public, non-secret)

**Files:**
- Create: `server/assets/setup/cc-hook.sh` (the raw bash script — a real `.sh` file, no escaping).
- Modify: `nuxt.config.ts` (register the Nitro server asset).
- Create: `server/api/setup/cc-hook.get.ts`
- Modify: `server/middleware/auth.ts`

The script reads `MYMIND_URL`/`MYMIND_TOKEN` from the env (falling back to `~/.mymind/config.env`), augments each event with git/machine context, POSTs the event, and on terminal events ships the transcript byte-offset delta. It always exits 0. Uses `python3` for JSON/offset handling (matches the proven bridget approach; present on macOS/Linux dev boxes).

**Why a real `.sh` file (not a TS string):** the script is full of `${…}` bash expansions and `\` sequences. A JS/TS template literal — even `String.raw` — would still interpolate `${…}` and mangle backslashes, corrupting the script. Storing it as an actual `.sh` file under `server/assets/` and reading it via Nitro's server-asset storage avoids ALL escaping issues and lets us `bash -n` the source directly.

**Forward-compat note:** the script POSTs top-level `git_branch`/`git_commit`/`git_remote`/`machine_id`/`hostname` fields. The current `/api/hooks/cc/[event]` handler's zod `Body` is non-strict, so it **silently strips** those extra fields today — no error. Persisting them is Phase 2 (Part C, capture fidelity); the script is intentionally written now so it doesn't need reinstalling later.

- [ ] **Step 1: Create the script file**

Create `server/assets/setup/cc-hook.sh` (a real bash file — paste the body below verbatim, no escaping):

```bash
#!/usr/bin/env bash
# mymind cc-hook — POSTs Claude Code session events + transcript deltas to MyMind.
# Install: curl -fsSL "$MYMIND_URL/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x ~/.mymind/cc-hook.sh
# Wire into ~/.claude/settings.json hooks as: ~/.mymind/cc-hook.sh <EventName>
set -u
cfgdir="$HOME/.mymind"
[ -f "$cfgdir/config.env" ] && . "$cfgdir/config.env"
url="${MYMIND_URL:-}"
tok="${MYMIND_TOKEN:-}"
log="$cfgdir/cc-hook.log"
offdir="$cfgdir/transcript-offsets"
mid_file="$cfgdir/machine_id"
mkdir -p "$offdir" 2>/dev/null

event="${1:-unknown}"
[ -z "$url" ] || [ -z "$tok" ] && exit 0   # not configured — silent no-op

# stable machine id
if [ ! -s "$mid_file" ]; then
  (command -v uuidgen >/dev/null && uuidgen | tr 'A-Z' 'a-z' || python3 -c 'import uuid;print(uuid.uuid4())') > "$mid_file" 2>/dev/null
fi
mid="$( [ -s "$mid_file" ] && cat "$mid_file" || echo '' )"
host="$(hostname -s 2>/dev/null || hostname)"

# read hook payload from stdin
payload="$(mktemp -t mymind.payload.XXXXXX)"
trap 'rm -f "$payload" "$body" 2>/dev/null' EXIT
cat > "$payload"
[ -s "$payload" ] || echo '{}' > "$payload"

# extract session_id, transcript_path, cwd
read -r sid tp cwd < <(MM_IN="$payload" python3 - <<'PY'
import json,os
try:
    d=json.load(open(os.environ["MM_IN"]))
    d=d if isinstance(d,dict) else {}
except Exception:
    d={}
print(d.get("session_id") or d.get("sessionId") or "",
      d.get("transcript_path") or "",
      d.get("cwd") or "")
PY
)

# git context (never fails)
gb="" ; gc="" ; gr="" ; proj=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  gb="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  gc="$(git -C "$cwd" rev-parse HEAD 2>/dev/null)"
  gr="$(git -C "$cwd" config --get remote.origin.url 2>/dev/null)"
  proj="$(basename "$cwd")"
fi

# POST the event (background; short timeout; never blocks)
{
  MM_SID="$sid" MM_CWD="$cwd" MM_PROJ="$proj" MM_GB="$gb" MM_GC="$gc" MM_GR="$gr" \
  MM_MID="$mid" MM_HOST="$host" MM_EV="$event" python3 - > "$payload.body" <<'PY'
import json,os
print(json.dumps({
  "source":"claude_code",
  "external_id":os.environ["MM_SID"],
  "project":os.environ["MM_PROJ"] or None,
  "cwd":os.environ["MM_CWD"] or None,
  "git_branch":os.environ["MM_GB"] or None,
  "git_commit":os.environ["MM_GC"] or None,
  "git_remote":os.environ["MM_GR"] or None,
  "machine_id":os.environ["MM_MID"] or None,
  "hostname":os.environ["MM_HOST"] or None,
  "metadata":{"hostname":os.environ["MM_HOST"],"lastEvent":os.environ["MM_EV"]}
}))
PY
  [ -n "$sid" ] && curl -sS -m 5 -X POST \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
    --data-binary "@$payload.body" "$url/api/hooks/cc/$event" \
    >/dev/null 2>&1 || echo "$(date '+%F %T') event=$event POST failed" >> "$log"
  rm -f "$payload.body" 2>/dev/null
} &

# ship transcript delta on terminal events
body=""
case "$event" in
  Stop|SubagentStop|SessionEnd)
    if [ -n "$sid" ] && [ -n "$tp" ] && [ -f "$tp" ]; then
      off_file="$offdir/$sid.off"
      prev=0; [ -f "$off_file" ] && prev=$(cat "$off_file" 2>/dev/null || echo 0)
      size=$(wc -c < "$tp" | tr -d ' ')
      [ "$prev" -gt "$size" ] && prev=0
      if [ "$size" -gt "$prev" ]; then
        body="$(mktemp -t mymind.body.XXXXXX)"
        consumed=$(MM_SID="$sid" MM_TP="$tp" MM_PREV="$prev" MM_OUT="$body" python3 - <<'PY'
import json,os
sid=os.environ["MM_SID"]; path=os.environ["MM_TP"]; prev=int(os.environ["MM_PREV"]); out=os.environ["MM_OUT"]
MAX=4*1024*1024
with open(path,"rb") as f:
    f.seek(prev); raw=f.read(MAX)
nl=raw.rfind(b"\n"); consumed=(nl+1) if nl>=0 else 0
text=raw[:consumed].decode("utf-8","replace")
lines=[l for l in text.split("\n") if l.strip()]
json.dump({"source":"claude_code","external_id":sid,"lines":lines}, open(out,"w"))
print(consumed)
PY
)
        if [ "${consumed:-0}" -gt 0 ]; then
          if curl -sS -m 15 -X POST \
              -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
              --data-binary "@$body" "$url/api/hooks/cc/transcript" >/dev/null 2>&1; then
            echo "$((prev + consumed))" > "$off_file"
          else
            echo "$(date '+%F %T') transcript POST failed sid=$sid" >> "$log"
          fi
        fi
      fi
    fi
    ;;
esac
wait 2>/dev/null || true
exit 0
```

- [ ] **Step 2: Register the Nitro server asset**

In `nuxt.config.ts`, inside the existing `nitro: { … }` block, add a `serverAssets` entry — MERGE it in; do NOT remove the existing `experimental`, `publicAssets`, or `scheduledTasks` keys:

```typescript
nitro: {
  // …existing experimental / publicAssets / scheduledTasks keys stay…
  serverAssets: [{ baseName: 'setup', dir: 'server/assets/setup' }]
}
```

- [ ] **Step 3: Serve the script**

Create `server/api/setup/cc-hook.get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const script = await useStorage('assets:setup').getItem('cc-hook.sh')
  if (typeof script !== 'string') {
    throw createError({ statusCode: 500, statusMessage: 'cc-hook.sh asset missing' })
  }
  setResponseHeader(event, 'content-type', 'text/x-shellscript; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'inline; filename="cc-hook.sh"')
  return script
})
```

`useStorage`/`createError`/`setResponseHeader` are Nitro auto-imports; the `assets:setup` mount comes from the `baseName` in Step 2. If `getItem` returns a non-string for this text asset (some storage drivers return a Buffer), coerce with `String(script)` after the guard — verify what Nitro actually returns during the Task 8 live check.

- [ ] **Step 4: Make `/api/setup` public**

In `server/middleware/auth.ts`, add `/api/setup` to the public prefixes (the script holds no secrets and must be `curl`-able without a token):

```typescript
const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/setup']
```

- [ ] **Step 5: Lint the script syntax + typecheck**

Run: `bash -n server/assets/setup/cc-hook.sh`
Expected: no output (exit 0 = valid bash syntax).

Run: `pnpm typecheck`
Expected: 0 errors.

(The live `curl http://localhost:3000/api/setup/cc-hook` check needs the dev server and is covered in Task 8 — do NOT start or disrupt a dev server here.)

- [ ] **Step 6: Commit**

```bash
git add server/assets/setup/cc-hook.sh nuxt.config.ts server/api/setup/cc-hook.get.ts server/middleware/auth.ts
git commit -m "feat(connect): serve cc-hook.sh installer at /api/setup/cc-hook (public)"
```

---

## Task 6: `useApiTokens` composable

**Files:**
- Create: `app/composables/useApiTokens.ts`

- [ ] **Step 1: Implement the composable**

Create `app/composables/useApiTokens.ts` (mirrors `useMemories.ts`):

```typescript
import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import type { ApiTokenDTO } from '~~/shared/types/api-token'

export type { ApiTokenDTO }

export function useApiTokens() {
  const useTokenList = () =>
    useQuery({
      queryKey: ['apiToken', 'list'] as const,
      queryFn: () => ofetch<ApiTokenDTO[]>('/api/settings/tokens')
    })

  const create = (name: string) =>
    ofetch<ApiTokenDTO & { token: string }>('/api/settings/tokens', { method: 'POST', body: { name } })

  const revoke = (id: string) =>
    ofetch<ApiTokenDTO>(`/api/settings/tokens/${id}/revoke`, { method: 'POST' })

  return { useTokenList, create, revoke }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck`
Expected: 0 errors. (If importing the DTO type from a `server/` path trips the typecheck, fall back to declaring the `ApiTokenDTO` interface inline in this file — it's a 6-field shape.)

```bash
git add app/composables/useApiTokens.ts
git commit -m "feat(tokens): useApiTokens vue-query composable"
```

---

## Task 7: API Keys settings tab (list + create + Connect)

**Files:**
- Create: `app/components/settings/ApiKeysTab.vue`
- Modify: `app/pages/settings.vue`

Invoke the `nuxt-ui-docs` skill before building to confirm v4 props for `UModal`, `UTable`/`UCard`, `UAlert`, `UBadge`, `UButton`, `UInput`, `UFormField`, `UTooltip`.

- [ ] **Step 1: Register the tab**

In `app/pages/settings.vue`, add to the `tabs` array and add a template slot:

```vue
const tabs = [
  { label: 'Providers', icon: 'i-lucide-server', slot: 'providers' as const },
  { label: 'Models', icon: 'i-lucide-box', slot: 'models' as const },
  { label: 'Model Configuration', icon: 'i-lucide-sliders-horizontal', slot: 'assignments' as const },
  { label: 'API Keys', icon: 'i-lucide-key-round', slot: 'apikeys' as const },
  { label: 'Activity & Alerts', icon: 'i-lucide-activity', slot: 'activity' as const }
]
```

And inside `<UTabs>`:

```vue
<template #apikeys><SettingsApiKeysTab /></template>
```

- [ ] **Step 2: Build the tab component**

Create `app/components/settings/ApiKeysTab.vue`:

```vue
<!-- app/components/settings/ApiKeysTab.vue -->
<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { ApiTokenDTO } from '~/composables/useApiTokens'

const { useTokenList, create, revoke } = useApiTokens()
const { data: tokens, error } = useTokenList()
const qc = useQueryClient()
const toast = useToast()

// Base origin for the copy-paste snippets (the domain the user is on IS the external URL).
const baseUrl = computed(() => import.meta.client ? window.location.origin : '')

// Create modal state
const createOpen = ref(false)
const newName = ref('')
const creating = ref(false)
// The most-recently-minted plaintext token (shown once). null once dismissed.
const minted = ref<(ApiTokenDTO & { token: string }) | null>(null)

async function submitCreate() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    minted.value = await create(newName.value.trim())
    newName.value = ''
    createOpen.value = false
    qc.invalidateQueries({ queryKey: ['apiToken', 'list'] })
  } catch {
    toast.add({ title: 'Failed to create token', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function doRevoke(t: ApiTokenDTO) {
  try {
    await revoke(t.id)
    qc.invalidateQueries({ queryKey: ['apiToken', 'list'] })
    toast.add({ title: `Revoked "${t.name}"`, color: 'neutral' })
  } catch {
    toast.add({ title: 'Failed to revoke token', color: 'error' })
  }
}

function copy(text: string) {
  if (import.meta.client) navigator.clipboard?.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

// The token value to show in the Connect snippets: the real one right after
// minting, otherwise a placeholder (we only ever hold the plaintext once).
const tokenForSnippets = computed(() => minted.value?.token ?? 'mm_•••••••• (paste your saved token)')

const mcpSnippet = computed(() => `{
  "mcpServers": {
    "mymind": {
      "type": "http",
      "url": "\${MYMIND_URL}/api/mcp",
      "headers": { "Authorization": "Bearer \${MYMIND_TOKEN}" }
    }
  }
}`)

const mcpCli = computed(() =>
  `claude mcp add --transport http --scope user \\
  --header "Authorization: Bearer \${MYMIND_TOKEN}" \\
  mymind "\${MYMIND_URL}/api/mcp"`)

const envSnippet = computed(() =>
  `export MYMIND_URL="${baseUrl.value}"
export MYMIND_TOKEN="${tokenForSnippets.value}"
mkdir -p ~/.mymind && printf 'MYMIND_URL=%s\\nMYMIND_TOKEN=%s\\n' "$MYMIND_URL" "$MYMIND_TOKEN" > ~/.mymind/config.env`)

const installSnippet = computed(() =>
  `curl -fsSL "${baseUrl.value}/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x ~/.mymind/cc-hook.sh`)

const hooksSnippet = `{
  "hooks": {
    "SessionStart":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh SessionStart" }] }],
    "UserPromptSubmit":[{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh UserPromptSubmit" }] }],
    "Stop":            [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh Stop" }] }],
    "SubagentStop":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh SubagentStop" }] }],
    "SessionEnd":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh SessionEnd" }] }]
  }
}`

const rows = computed(() => tokens.value ?? [])
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- Header + create -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-highlighted">API keys</h2>
        <p class="text-sm text-muted">Bearer tokens for ShareX uploads, the Claude Code hooks, and MCP.</p>
      </div>
      <UButton icon="i-lucide-plus" label="Create token" color="primary" @click="createOpen = true" />
    </div>

    <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" title="Couldn't load tokens" />

    <!-- One-time plaintext reveal -->
    <UAlert
      v-if="minted"
      color="warning"
      icon="i-lucide-key-round"
      title="Copy your token now — you won't see it again"
      :close="true"
      @update:open="(o) => { if (!o) minted = null }"
    >
      <template #description>
        <div class="flex items-center gap-2 mt-2">
          <code class="font-mono text-sm bg-elevated px-2 py-1 rounded break-all flex-1">{{ minted.token }}</code>
          <UButton size="xs" icon="i-lucide-copy" color="neutral" @click="copy(minted.token)" />
        </div>
      </template>
    </UAlert>

    <!-- Token list -->
    <div class="flex flex-col divide-y divide-default border border-default rounded-lg">
      <div v-for="t in rows" :key="t.id" class="flex items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-0">
          <div class="font-medium text-default truncate">{{ t.name }}</div>
          <div class="text-xs text-muted font-mono">mm_…{{ t.lastFour ?? '????' }}</div>
        </div>
        <div class="text-xs text-muted hidden sm:block">
          {{ new Date(t.createdAt).toLocaleDateString() }}
        </div>
        <div class="text-xs text-muted hidden sm:block w-28 text-right">
          {{ t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used' }}
        </div>
        <UBadge :color="t.revokedAt ? 'neutral' : 'success'" variant="subtle">
          {{ t.revokedAt ? 'Revoked' : 'Active' }}
        </UBadge>
        <UButton
          v-if="!t.revokedAt"
          size="xs" color="error" variant="ghost" icon="i-lucide-trash-2"
          @click="doRevoke(t)"
        />
      </div>
      <div v-if="rows.length === 0" class="px-4 py-6 text-sm text-muted text-center">
        No tokens yet. Create one to connect Claude Code.
      </div>
    </div>

    <!-- Connect to Claude Code -->
    <div class="flex flex-col gap-4 border-t border-default pt-6">
      <div>
        <h2 class="text-base font-semibold text-highlighted">Connect to Claude Code</h2>
        <p class="text-sm text-muted">Run these once on each machine. Snippets carry no secret — your token lives in two env vars.</p>
      </div>

      <div v-for="step in [
        { n: 1, title: 'Set your token', code: envSnippet, note: minted ? 'Pre-filled with your new token.' : 'Replace mm_•••• with the token you saved.' },
        { n: 2, title: 'Add the MCP server (.mcp.json or ~/.claude.json)', code: mcpSnippet },
        { n: 2.1, title: '…or via the CLI', code: mcpCli },
        { n: 3, title: 'Install the session-logging hook', code: installSnippet },
        { n: 3.1, title: '…then add to ~/.claude/settings.json', code: hooksSnippet }
      ]" :key="String(step.n)">
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm font-medium text-toned">{{ step.title }}</span>
          <UButton size="xs" icon="i-lucide-copy" color="neutral" variant="ghost" @click="copy(step.code)" />
        </div>
        <p v-if="step.note" class="text-xs text-muted mb-1">{{ step.note }}</p>
        <pre class="bg-elevated border border-default rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre">{{ step.code }}</pre>
      </div>
    </div>

    <!-- Create modal -->
    <UModal v-model:open="createOpen" title="Create API token">
      <template #body>
        <UFormField label="Name" help="A label so you remember what this token is for (e.g. 'laptop ShareX').">
          <UInput v-model="newName" placeholder="my-laptop" autofocus @keyup.enter="submitCreate" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="createOpen = false" />
          <UButton label="Create" color="primary" :loading="creating" :disabled="!newName.trim()" @click="submitCreate" />
        </div>
      </template>
    </UModal>
  </div>
</template>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. If a Nuxt UI prop is rejected, confirm the correct v4 prop via the `nuxt-ui-docs` skill and adjust (do not switch to raw markup).

- [ ] **Step 4: Commit**

```bash
git add app/components/settings/ApiKeysTab.vue app/pages/settings.vue
git commit -m "feat(tokens): API Keys settings tab — list, mint-once, revoke, Connect snippets"
```

---

## Task 8: Gates + end-to-end validation

**Files:** none (verification only).

- [ ] **Step 1: Full static gates**

Run: `pnpm typecheck` → 0 errors.
Run: `pnpm test` → all pass (the existing suite + the 2 new specs; note the count, was 250).
Run: `pnpm build` → succeeds.

- [ ] **Step 2: E2E with playwright-cli** (dev server running)

Drive the real UI (create a test session/login as needed):
1. Go to `/settings` → **API Keys** tab → **Create token** → name it → submit.
2. Assert the one-time plaintext `mm_…` appears and the row shows `mm_…<lastFour>` + **Active**.
3. Copy the token value from the reveal.
4. From a shell, hit a protected endpoint with it:
   `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <token>" http://localhost:3000/api/memories` → **200**.
5. MCP check: `curl -s -X POST http://localhost:3000/api/mcp -H "Authorization: Bearer <token>" -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → returns the tool list (not 401).
6. In the UI, **Revoke** the token → row flips to **Revoked**.
7. Re-run step 4 → **401**.
8. Privilege check: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <token-from-step6-or-a-fresh-one>" http://localhost:3000/api/settings/tokens` → **403** (a bearer client cannot list/manage tokens).

- [ ] **Step 3: Connect-script smoke**

Run: `curl -fsSL http://localhost:3000/api/setup/cc-hook -o /tmp/cc-hook.sh && bash -n /tmp/cc-hook.sh && echo "syntax OK"`
Expected: `syntax OK` (bash parses the script).

Optional live ingest check (with a valid token exported as `MYMIND_TOKEN` + `MYMIND_URL=http://localhost:3000`):
`echo '{"session_id":"test-sess-1","cwd":"'"$PWD"'"}' | bash /tmp/cc-hook.sh SessionStart` → then confirm a session row appears at `/sessions` (or `GET /api/sessions`).

- [ ] **Step 4: Cross-tab live check**

Open `/settings` API Keys in two browser tabs; create a token in one → it appears in the other without reload (validates the `apiToken` live wiring).

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
git add -A && git commit -m "test(tokens): phase-1 gates + E2E validation green"
```

---

## Done criteria for Phase 1
- Mint / list / revoke tokens from `/settings`; plaintext shown exactly once.
- Bearer tokens work against the API + MCP; revoked tokens 401; token-management endpoints reject bearer clients (403).
- `/api/setup/cc-hook` serves a syntactically-valid, secret-free installer; the Connect tab shows correct env/MCP/hooks snippets for this host.
- All static gates green; token list is live across tabs.
- **Next:** Phase 2 plan (capture fidelity) — the gate before pointing real CC hooks at MyMind.
