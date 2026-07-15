# Session ↔ Project Reassignment + Path-Based Auto-Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let sessions be reassigned to any project (single + bulk), auto-route no-git-remote sessions by learned path prefixes (auto-creating a project from the first fresh folder, stoplisted), and surface the machine hostname where triage happens.

**Architecture:** A new pure helper module (`path-routing.ts`) holds all routing/stoplist decision logic (unit-tested, DB-free). `findOrCreateProject`'s no-remote branch is rewritten to use it. A new `projects.path_prefixes` column stores routing roots (separate from the passively-accumulated `local_paths`). Reassignment is a thin DB service + two Nitro endpoints + a shared modal; it cascades to agent-scoped memories and emits live events. A one-time script re-resolves the existing `uncategorized` backlog against existing projects only.

**Tech Stack:** Nuxt 4, Nitro server routes, Drizzle ORM (Postgres/pgvector), drizzle-kit migrations, `@tanstack/vue-query` + SSE live-bus, Nuxt UI v4, Vitest, `playwright-cli`.

## Global Constraints

- **Package manager:** `pnpm` only (never npm/yarn). Run from repo root.
- **Spec:** `docs/superpowers/specs/2026-07-15-session-project-reassignment-design.md` — implement it verbatim; decisions there are frozen.
- **Live-data rule:** every successful mutation calls `publishChange({ resource, action, id })` after commit; `resource` must be a member of `ResourceName` (`shared/types/live.ts` — `session`, `project`, `memory` all exist). The client invalidator (`app/utils/live-dispatch.ts`) refetches `[resource, id]` and `[resource, 'list']` for every event.
- **Reads via `@tanstack/vue-query`** (`useQuery`); the data ref is read-only. **Writes are plain `$fetch`/`ofetch` functions in composables** — the established idiom (see `useProjects.ts`); cross-tab + local refetch happens through the SSE live event, not `useMutation`.
- **Vue/Nuxt UI:** use `U*` components; semantic color tokens only (`primary`, `neutral`, `text-muted`, `border-default`, …) — never raw palette classes. Invoke `nuxt-ui-docs` before using an unfamiliar component API (Nuxt UI v4).
- **reka-ui gotcha:** `USelectMenu`/`USelect` items must never have an empty-string `value` — it throws and crashes the popover. Use a non-empty sentinel (e.g. `'__create__'`).
- **Validate UI in the browser with `playwright-cli`** (invoke the `browser-testing` skill), NOT the Playwright MCP. Green typecheck/test/build do not catch rendering/wiring bugs.
- **Gates:** `pnpm test`, `pnpm typecheck`, `pnpm build` must pass. Lint is repo-wide red and is NOT a gate.
- **Tests:** follow the repo idiom — extract PURE functions and unit-test them in `test/*.test.ts` (see `test/git-remote.test.ts`, `test/project-merge.test.ts`). DB-touching orchestration is proven by browser E2E, not a test-DB harness (none exists).
- **Commits:** explicit paths only (`git add <path>` — never `git add -A`; the tree has unrelated untracked/modified files). Branch is `feat/session-project-reassignment` (already created). Each commit message ends with the two trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EAKNXsY63xxM7WDSYBAXUu
  ```

---

### Task 1: Pure path-routing helpers

**Files:**
- Create: `server/lib/projects/path-routing.ts`
- Test: `test/path-routing.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces:
  - `normalizePrefix(path: string): string` — trim + strip trailing slashes (root `/` preserved).
  - `basenameOf(path: string): string` — last non-empty segment (`''` if none).
  - `isUnderPrefix(cwd: string, prefix: string): boolean` — true iff `cwd` equals or is a descendant of `prefix`.
  - `interface PrefixCandidate { id: string; slug: string; prefixes: string[] }`
  - `longestPrefixMatch(cwd: string, candidates: PrefixCandidate[]): PrefixCandidate | null` — candidate with the longest ancestor-or-equal prefix.
  - `isAutoCreatable(cwd: string | null | undefined): boolean` — false for home roots, temp dirs, and generic container leaf names.

- [ ] **Step 1: Write the failing test**

Create `test/path-routing.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  normalizePrefix, basenameOf, isUnderPrefix, longestPrefixMatch, isAutoCreatable
} from '../server/lib/projects/path-routing'

describe('normalizePrefix', () => {
  it('strips trailing slashes and trims; preserves root', () => {
    expect(normalizePrefix('/a/b/')).toBe('/a/b')
    expect(normalizePrefix('  /a/b  ')).toBe('/a/b')
    expect(normalizePrefix('/')).toBe('/')
    expect(normalizePrefix('')).toBe('')
  })
})

describe('basenameOf', () => {
  it('returns the last non-empty segment', () => {
    expect(basenameOf('/Users/tony/Documents/Projects/Terawulf')).toBe('Terawulf')
    expect(basenameOf('/a/b/BOM Schedules')).toBe('BOM Schedules')
    expect(basenameOf('/')).toBe('')
  })
})

describe('isUnderPrefix', () => {
  it('matches equal and descendant paths, not siblings or partial segments', () => {
    expect(isUnderPrefix('/p/Terawulf', '/p/Terawulf')).toBe(true)
    expect(isUnderPrefix('/p/Terawulf/MTO/Piping', '/p/Terawulf')).toBe(true)
    expect(isUnderPrefix('/p/Terawulf', '/p/Terawulf/MTO')).toBe(false) // parent is not under child
    expect(isUnderPrefix('/p/Terawulf2', '/p/Terawulf')).toBe(false)    // sibling, partial segment
    expect(isUnderPrefix('/p/a/b', '/p/a/')).toBe(true)                  // trailing slash tolerated
  })
})

describe('longestPrefixMatch', () => {
  const cands = [
    { id: '1', slug: 'terawulf', prefixes: ['/p/Terawulf'] },
    { id: '2', slug: 'mto', prefixes: ['/p/Terawulf/MTO'] }
  ]
  it('returns the longest ancestor-or-equal match', () => {
    expect(longestPrefixMatch('/p/Terawulf/MTO/Piping', cands)?.slug).toBe('mto')
    expect(longestPrefixMatch('/p/Terawulf/BOM Schedules', cands)?.slug).toBe('terawulf')
  })
  it('returns null when nothing matches', () => {
    expect(longestPrefixMatch('/other/place', cands)).toBeNull()
  })
})

describe('isAutoCreatable', () => {
  it('rejects home roots, temp, and generic container leaves', () => {
    expect(isAutoCreatable('/Users/tony')).toBe(false)
    expect(isAutoCreatable('/home/tony')).toBe(false)
    expect(isAutoCreatable('/mnt/c/Users/tonyc')).toBe(false)
    expect(isAutoCreatable('/tmp')).toBe(false)
    expect(isAutoCreatable('/tmp/scratch')).toBe(false)
    expect(isAutoCreatable('/Users/tony/Documents/GitHub')).toBe(false) // generic leaf 'github'
    expect(isAutoCreatable(null)).toBe(false)
    expect(isAutoCreatable('/')).toBe(false)
  })
  it('accepts real project folders', () => {
    expect(isAutoCreatable('/mnt/c/Users/tonyc/Documents/Projects/Terawulf')).toBe(true)
    expect(isAutoCreatable('/Users/tony/Documents/GitHub/mymind')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test path-routing`
Expected: FAIL — `Cannot find module '../server/lib/projects/path-routing'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/projects/path-routing.ts`:

```ts
/**
 * Pure path-based routing helpers for sessions with no git remote. No imports,
 * no I/O — all decision logic that findOrCreateProject / the re-resolve backfill
 * share lives here so it can be unit-tested (mirrors ./git-remote.ts).
 */

/** Trim + strip trailing slashes. Root '/' is preserved. Pure. */
export function normalizePrefix(path: string): string {
  const t = (path ?? '').trim()
  if (!t) return ''
  const stripped = t.replace(/\/+$/, '')
  return stripped || '/'
}

/** Last non-empty path segment ('' when none). Pure. */
export function basenameOf(path: string): string {
  const seg = normalizePrefix(path).split('/').filter(Boolean)
  return seg[seg.length - 1] ?? ''
}

/** True when `cwd` equals `prefix` or is a descendant directory of it. Pure. */
export function isUnderPrefix(cwd: string, prefix: string): boolean {
  const c = normalizePrefix(cwd)
  const p = normalizePrefix(prefix)
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(p === '/' ? '/' : p + '/')
}

export interface PrefixCandidate { id: string, slug: string, prefixes: string[] }

/** Candidate whose registered prefix is the LONGEST ancestor-or-equal of cwd. Pure. */
export function longestPrefixMatch(cwd: string, candidates: PrefixCandidate[]): PrefixCandidate | null {
  let best: PrefixCandidate | null = null
  let bestLen = -1
  for (const cand of candidates) {
    for (const raw of cand.prefixes ?? []) {
      const p = normalizePrefix(raw)
      if (p && isUnderPrefix(cwd, p) && p.length > bestLen) { best = cand; bestLen = p.length }
    }
  }
  return best
}

// Stoplist — never auto-create a project from these bare/scratch cwds.
const HOME_ROOT_RE = [/^\/(?:Users|home)\/[^/]+$/i, /^\/mnt\/[a-z]\/Users\/[^/]+$/i]
const TEMP_RE = /^\/(?:private\/)?(?:tmp|var\/tmp)(?:\/|$)/i
const GENERIC_LEAVES = new Set([
  'documents', 'github', 'downloads', 'desktop', 'src', 'projects', 'code', 'repos', 'dev', 'tmp', 'temp'
])

/** Whether a cwd is a "real" project folder we may auto-create a project from. Pure. */
export function isAutoCreatable(cwd: string | null | undefined): boolean {
  if (!cwd) return false
  const p = normalizePrefix(cwd)
  if (!p || p === '/') return false
  if (HOME_ROOT_RE.some(re => re.test(p))) return false
  if (TEMP_RE.test(p)) return false
  if (GENERIC_LEAVES.has(basenameOf(p).toLowerCase())) return false
  return true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test path-routing`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → no new errors in `path-routing.ts`.

```bash
git add server/lib/projects/path-routing.ts test/path-routing.test.ts
git commit -m "feat(projects): pure path-routing helpers (prefix match + auto-create stoplist)
<trailers>"
```

---

### Task 2: `path_prefixes` column + ProjectDTO field

**Files:**
- Modify: `server/db/schema/projects.ts` (add column after `localPaths`, line 16)
- Create: `server/db/migrations/00XX_*.sql` (generated by drizzle-kit — do not hand-write)
- Modify: `shared/types/tasks.ts` (`ProjectDTO`, after `localPaths` line 30)
- Modify: `server/services/projects.ts` (`toDTO`, ~line 45)

**Interfaces:**
- Produces: `projects.pathPrefixes` (drizzle column, `text[]` not-null default `{}`); `ProjectDTO.pathPrefixes: string[]`.

- [ ] **Step 1: Add the schema column**

In `server/db/schema/projects.ts`, after the `localPaths` line (16), add:

```ts
  pathPrefixes: text('path_prefixes').array().notNull().default(sql`'{}'::text[]`),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `server/db/migrations/00XX_<random-name>.sql` containing `ALTER TABLE "projects" ADD COLUMN "path_prefixes" text[] DEFAULT '{}'::text[] NOT NULL;`. Verify with:

Run: `git status --short server/db/migrations`

- [ ] **Step 3: Apply the migration to the dev DB**

Run: `pnpm db:migrate`
Expected: applies cleanly (`0027` or next number).

- [ ] **Step 4: Add `pathPrefixes` to the DTO and mapper**

In `shared/types/tasks.ts`, in `ProjectDTO` after `localPaths: string[]` (line 30):

```ts
  pathPrefixes: string[]
```

In `server/services/projects.ts`, in `toDTO` add to the returned object (next to `localPaths`):

```ts
    aliases: r.aliases ?? [], localPaths: r.localPaths ?? [], pathPrefixes: r.pathPrefixes ?? [],
```

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add server/db/schema/projects.ts server/db/migrations shared/types/tasks.ts server/services/projects.ts
git commit -m "feat(projects): add path_prefixes column + DTO field
<trailers>"
```

---

### Task 3: Rewrite the no-remote resolver + thread `git_root`

**Files:**
- Modify: `server/services/projects.ts` (`findOrCreateProject`, lines 191-237; add imports at top)
- Modify: `server/services/sessions.ts` (`UpsertSessionInput` line 13-27; `upsertSession` resolve block lines 50-56)
- Modify: `server/api/hooks/cc/[event].post.ts` (Zod `Body`, `upsertSession` call)
- Modify: `server/assets/setup/cc-hook.sh` (compute + send `git_root`)

**Interfaces:**
- Consumes: `longestPrefixMatch`, `basenameOf`, `isAutoCreatable`, `normalizePrefix` (Task 1); `projects.pathPrefixes` (Task 2); existing `normalizeGitRemote`, `repoNameFromKey`, `nextUniqueSlug`, `slugify`, `matchProjectByLabel`.
- Produces: `findOrCreateProject({ gitRemote?, cwd?, gitRoot? })` — no-remote branch now does prefix-match → label-match (cwd basename, then git-root basename) → auto-create (stoplisted) → uncategorized. `UpsertSessionInput.gitRoot?: string | null`.

- [ ] **Step 1: Add imports in `server/services/projects.ts`**

Extend the existing import from `../lib/projects/git-remote` and add the path-routing import (top of file, near line 6):

```ts
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../lib/projects/git-remote'
import { longestPrefixMatch, basenameOf, isAutoCreatable, normalizePrefix } from '../lib/projects/path-routing'
```

- [ ] **Step 2: Rewrite `findOrCreateProject`**

Replace the whole function (lines 191-237) with:

```ts
/**
 * Resolve a session's project. With a git remote: match by normalized remote key
 * (then aliases), creating on first sight. Without a remote: match by longest
 * registered path prefix, then by cwd/git-root basename label, then AUTO-CREATE a
 * project from the cwd's leaf folder (registering the cwd as a path prefix) unless
 * the cwd is stoplisted, in which case fall back to the seeded Uncategorized bucket.
 */
export async function findOrCreateProject(input: { gitRemote?: string | null, cwd?: string | null, gitRoot?: string | null }): Promise<typeof projects.$inferSelect> {
  const db = useDb()
  const key = normalizeGitRemote(input.gitRemote)
  const cwd = input.cwd ?? null

  // Touch a matched project: append cwd to local_paths + bump last_activity_at.
  const touch = async (proj: typeof projects.$inferSelect): Promise<typeof projects.$inferSelect> => {
    const localPaths = (proj.localPaths ?? [])
    const nextPaths = cwd && !localPaths.includes(cwd) ? [...localPaths, cwd] : localPaths
    const now = new Date()
    await db.update(projects).set({ localPaths: nextPaths, lastActivityAt: now, updatedAt: now }).where(eq(projects.id, proj.id))
    return { ...proj, localPaths: nextPaths, lastActivityAt: now }
  }

  if (!key) {
    // 1. Longest registered path-prefix wins.
    if (cwd) {
      const rows = await db.select({ id: projects.id, slug: projects.slug, prefixes: projects.pathPrefixes }).from(projects)
      const hit = longestPrefixMatch(cwd, rows.map(r => ({ id: r.id, slug: r.slug, prefixes: r.prefixes ?? [] })))
      if (hit) {
        const [proj] = await db.select().from(projects).where(eq(projects.id, hit.id)).limit(1)
        if (proj) return touch(proj)
      }
    }
    // 2. Label match: cwd basename, then git-root basename.
    for (const label of [cwd ? basenameOf(cwd) : null, input.gitRoot ? basenameOf(input.gitRoot) : null]) {
      if (label) { const m = await matchProjectByLabel(label); if (m) return touch(m) }
    }
    // 3. Auto-create from the cwd leaf, unless the cwd is bare/scratch (stoplisted).
    if (cwd && isAutoCreatable(cwd)) {
      const prefix = normalizePrefix(cwd)
      const taken = new Set((await db.select({ slug: projects.slug }).from(projects)).map(r => r.slug))
      const slug = nextUniqueSlug(slugify(basenameOf(prefix)) || 'project', taken)
      try {
        const [created] = await db.insert(projects).values({
          slug, name: basenameOf(prefix), pathPrefixes: [prefix], localPaths: [cwd], lastActivityAt: new Date()
        }).returning()
        return created!
      } catch {
        // slug race — re-select by the prefix we tried to register.
        const rows = await db.select().from(projects)
        const racer = rows.find(r => (r.pathPrefixes ?? []).includes(prefix))
        if (racer) return racer
      }
    }
    // 4. Uncategorized fallback (seeded by migration 0019).
    const [u] = await db.select().from(projects).where(eq(projects.slug, 'uncategorized')).limit(1)
    return u!
  }

  let [proj] = await db.select().from(projects).where(eq(projects.gitRemoteKey, key)).limit(1)
  if (!proj) {
    ;[proj] = await db.select().from(projects).where(sql`${projects.aliases} @> ARRAY[${key}]::text[]`).limit(1)
  }
  if (proj) return touch(proj)

  const taken = new Set((await db.select({ slug: projects.slug }).from(projects)).map(r => r.slug))
  const slug = nextUniqueSlug(slugify(repoNameFromKey(key)) || 'project', taken)
  try {
    const [created] = await db.insert(projects).values({
      slug, name: repoNameFromKey(key), gitRemoteKey: key,
      repositoryUrl: input.gitRemote ?? null,
      localPaths: cwd ? [cwd] : [], lastActivityAt: new Date()
    }).returning()
    return created!
  } catch {
    const [racer] = await db.select().from(projects).where(eq(projects.gitRemoteKey, key)).limit(1)
    if (racer) return racer
    throw new Error(`findOrCreateProject: failed to create or find project for key ${key}`)
  }
}
```

- [ ] **Step 3: Thread `gitRoot` through `upsertSession`**

In `server/services/sessions.ts`, add to `UpsertSessionInput` (after `gitRemote?` line 24):

```ts
  gitRoot?: string | null
```

In `upsertSession`, update the resolve block (lines 52-56) to pass `gitRoot`:

```ts
  if (input.gitRemote != null || input.cwd != null) {
    const proj = await findOrCreateProject({ gitRemote: input.gitRemote, cwd: input.cwd, gitRoot: input.gitRoot })
    resolvedProjectId = proj.id
    resolvedProjectSlug = proj.slug
  }
```

(`gitRoot` is used only transiently for the label match; it is NOT persisted — there is no column for it.)

- [ ] **Step 4: Accept `git_root` in the hook route**

In `server/api/hooks/cc/[event].post.ts`, add to `Body` (after `git_remote` line 12):

```ts
  git_root: z.string().nullish(),
```

And in the `upsertSession({ … })` call (after `gitRemote:` line 39):

```ts
    gitRoot: body.git_root ?? undefined,
```

- [ ] **Step 5: Send `git_root` from the hook script**

In `server/assets/setup/cc-hook.sh`, in the git-context block (lines 47-53), add `gr_root`:

```bash
gb="" ; gc="" ; gr="" ; gr_root="" ; proj=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  gb="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  gc="$(git -C "$cwd" rev-parse HEAD 2>/dev/null)"
  gr="$(git -C "$cwd" config --get remote.origin.url 2>/dev/null)"
  gr_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"
  proj="$(basename "$cwd")"
fi
```

In the POST body block, add `MM_GRR` to the env prefix (line ~57) and the field to the Python dict (after `git_remote` line 67):

```bash
  MM_SID="$sid" MM_CWD="$cwd" MM_PROJ="$proj" MM_GB="$gb" MM_GC="$gc" MM_GR="$gr" MM_GRR="$gr_root" \
```
```python
  "git_remote":os.environ["MM_GR"] or None,
  "git_root":os.environ["MM_GRR"] or None,
```

- [ ] **Step 6: Verify — helpers green, typecheck, build**

The routing decision logic is covered by Task 1's unit tests; the wired `findOrCreateProject` is proven end-to-end in Task 8 (browser). Here, confirm nothing regressed:

Run: `pnpm test` → all green (incl. `git-remote`, `path-routing`).
Run: `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/projects.ts server/services/sessions.ts server/api/hooks/cc/\[event\].post.ts server/assets/setup/cc-hook.sh
git commit -m "feat(sessions): path-prefix routing + auto-create + git_root label match
<trailers>"
```

---

### Task 4: Surface the machine hostname (list + detail + filter)

**Files:**
- Modify: `shared/types/session.ts` (`SessionListItem`, line 1-13)
- Modify: `server/services/sessions.ts` (`listSessions` select + map lines 200-238; `getSessionMeta` return lines 252-272)
- Modify: `app/pages/sessions/index.vue` (row stats + filter)
- Modify: `app/pages/sessions/[id].vue` (machine line)

**Interfaces:**
- Consumes: `sessions.hostname` (existing column).
- Produces: `SessionListItem.hostname: string | null` (so `SessionMeta` inherits it).

- [ ] **Step 1: Add `hostname` to the type**

In `shared/types/session.ts`, in `SessionListItem` after `project: string | null` (line 4):

```ts
  hostname: string | null
```

- [ ] **Step 2: Return `hostname` from the read services**

In `server/services/sessions.ts` `listSessions`, add to the `.select({ … })` (after `project: sessions.project` line 203):

```ts
      hostname: sessions.hostname,
```

and to the returned map object (after `project: r.project` ~line 228):

```ts
    hostname: r.hostname,
```

In `getSessionMeta`, add to the returned object (after `project: session.project` ~line 255):

```ts
    hostname: session.hostname,
```

- [ ] **Step 3: Show hostname + add a hostname filter on the list page**

In `app/pages/sessions/index.vue` `<script setup>`:

Add a distinct-hostnames computed + items (after `distinctProjects`, ~line 46):

```ts
const distinctHostnames = computed(() => {
  const seen = new Set<string>()
  for (const s of sessions.value) if (s.hostname) seen.add(s.hostname)
  return [...seen].sort()
})
const hostnameItems = computed(() => [
  { label: 'All machines', value: '__all__' },
  ...distinctHostnames.value.map(h => ({ label: h, value: h }))
])
```

Add the filter ref (after `projectFilter` line 60):

```ts
const hostnameFilter = ref('__all__')
```

Add to the `filtered` computed (after the project filter block, ~line 70):

```ts
  if (hostnameFilter.value !== '__all__') {
    rows = rows.filter(s => s.hostname === hostnameFilter.value)
  }
```

In the template, add a third `USelect` after the project filter (~line 140):

```vue
          <USelect
            v-model="hostnameFilter"
            :items="hostnameItems"
            value-key="value"
            class="w-44 shrink-0"
          />
```

And in the stats row of each card (after the tools `<span>`, ~line 224), show the machine:

```vue
              <span
                v-if="session.hostname"
                class="flex items-center gap-1"
              >
                <UIcon name="i-lucide-monitor" class="size-3.5" />
                {{ session.hostname }}
              </span>
```

- [ ] **Step 4: Show hostname on the detail page**

In `app/pages/sessions/[id].vue`, replace the `machineId` line (lines 256-261) so the friendly hostname leads and the UUID becomes a tooltip fallback:

```vue
                  <p
                    v-if="meta.hostname || meta.machineId"
                    class="text-xs text-dimmed font-mono truncate"
                    :title="meta.machineId ?? undefined"
                  >
                    <UIcon name="i-lucide-monitor" class="size-3.5 inline mr-1" />{{ meta.hostname ?? meta.machineId }}
                  </p>
```

Also update the wrapping `v-if` on the metadata block (line 235) to include hostname:

```vue
                  v-if="meta.cwd || gitBranch || gitRepo || meta.hostname || meta.machineId || meta.appVersion"
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Browser validation**

Invoke the `browser-testing` skill. With the dev server running and logged in:
- Go to `/sessions`; assert at least one row shows a monitor icon + a hostname (e.g. `Tony-NLS` or `MacBook-Pro`).
- Select the hostname filter → a single machine → assert the list narrows to only that machine's rows.
- Open a session detail page; assert the machine line shows the hostname (not the raw UUID).

- [ ] **Step 7: Commit**

```bash
git add shared/types/session.ts server/services/sessions.ts app/pages/sessions/index.vue app/pages/sessions/\[id\].vue
git commit -m "feat(sessions): surface machine hostname on list + detail + hostname filter
<trailers>"
```

---

### Task 5: Reassign service, endpoints, and composable

**Files:**
- Modify: `server/services/sessions.ts` (imports; add `reassignSession`, `reassignSessions`)
- Create: `server/api/sessions/[id].patch.ts`
- Create: `server/api/sessions/reassign.post.ts`
- Modify: `app/composables/useSessions.ts` (add `reassign`, `reassignMany`)

**Interfaces:**
- Consumes: `normalizePrefix` (Task 1); `projects`, `memories` schema; `projects.pathPrefixes` (Task 2).
- Produces:
  - `reassignSession(id: string, opts: { projectSlug: string; pathPrefix?: string | null }): Promise<{ from: string | null; to: string }>`
  - `reassignSessions(ids: string[], opts: { projectSlug: string; pathPrefix?: string | null }): Promise<{ froms: (string | null)[]; to: string }>`
  - `PATCH /api/sessions/:id` body `{ project: string, pathPrefix?: string | null }`
  - `POST /api/sessions/reassign` body `{ ids: string[], project: string, pathPrefix?: string | null }`
  - composable: `reassign(id, body)`, `reassignMany(body)`

- [ ] **Step 1: Extend imports in `server/services/sessions.ts`**

```ts
import { asc, desc, eq, and, sql } from 'drizzle-orm'
import { sessions, messages, toolEvents, projects, memories } from '../db/schema'
import { normalizePrefix } from '../lib/projects/path-routing'
```

(add `and` to the drizzle import; add `projects, memories` to the schema import; add the path-routing import.)

- [ ] **Step 2: Add the reassign service functions**

Append to `server/services/sessions.ts` (after `upsertSession`, before the read-only views):

```ts
// ---------------------------------------------------------------------------
// Reassignment
// ---------------------------------------------------------------------------

/** Move one session + its agent-scoped memories onto `proj` within a tx. Returns the previous slug. */
async function applyReassign(tx: Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0], id: string, proj: typeof projects.$inferSelect): Promise<string | null> {
  const [sess] = await tx.select({ project: sessions.project }).from(sessions).where(eq(sessions.id, id)).limit(1)
  if (!sess) throw new Error(`session not found: ${id}`)
  await tx.update(sessions).set({ project: proj.slug, projectId: proj.id }).where(eq(sessions.id, id))
  await tx.update(memories).set({ project: proj.slug, projectId: proj.id })
    .where(and(eq(memories.sessionId, id), eq(memories.scope, 'agent')))
  return sess.project
}

/** Append a normalized path prefix to a project's path_prefixes (dedup), within a tx. */
async function registerPrefix(tx: Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0], proj: typeof projects.$inferSelect, rawPrefix: string): Promise<void> {
  const prefix = normalizePrefix(rawPrefix)
  const cur = proj.pathPrefixes ?? []
  if (prefix && !cur.includes(prefix)) {
    await tx.update(projects).set({ pathPrefixes: [...cur, prefix], updatedAt: new Date() }).where(eq(projects.id, proj.id))
  }
}

export async function reassignSession(id: string, opts: { projectSlug: string, pathPrefix?: string | null }): Promise<{ from: string | null, to: string }> {
  const db = useDb()
  const [proj] = await db.select().from(projects).where(eq(projects.slug, opts.projectSlug)).limit(1)
  if (!proj) throw new Error(`project not found: ${opts.projectSlug}`)
  let from: string | null = null
  await db.transaction(async (tx) => {
    from = await applyReassign(tx, id, proj)
    if (opts.pathPrefix) await registerPrefix(tx, proj, opts.pathPrefix)
  })
  return { from, to: proj.slug }
}

export async function reassignSessions(ids: string[], opts: { projectSlug: string, pathPrefix?: string | null }): Promise<{ froms: (string | null)[], to: string }> {
  const db = useDb()
  const [proj] = await db.select().from(projects).where(eq(projects.slug, opts.projectSlug)).limit(1)
  if (!proj) throw new Error(`project not found: ${opts.projectSlug}`)
  const froms: (string | null)[] = []
  await db.transaction(async (tx) => {
    for (const id of ids) froms.push(await applyReassign(tx, id, proj))
    if (opts.pathPrefix) await registerPrefix(tx, proj, opts.pathPrefix)
  })
  return { froms, to: proj.slug }
}
```

- [ ] **Step 3: Create the single-reassign endpoint**

Create `server/api/sessions/[id].patch.ts`:

```ts
import { z } from 'zod'
import { reassignSession } from '../../services/sessions'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({ project: z.string().min(1), pathPrefix: z.string().nullish() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  let res
  try {
    res = await reassignSession(id, { projectSlug: body.project, pathPrefix: body.pathPrefix ?? null })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw createError({ statusCode: msg.includes('not found') ? 404 : 400, statusMessage: msg })
  }
  publishChange({ resource: 'session', action: 'updated', id })
  if (res.from) publishChange({ resource: 'project', action: 'updated', id: res.from })
  publishChange({ resource: 'project', action: 'updated', id: res.to })
  publishChange({ resource: 'memory', action: 'updated', id })
  return { ok: true, ...res }
})
```

- [ ] **Step 4: Create the bulk-reassign endpoint**

Create `server/api/sessions/reassign.post.ts`:

```ts
import { z } from 'zod'
import { reassignSessions } from '../../services/sessions'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  ids: z.array(z.string().min(1)).min(1),
  project: z.string().min(1),
  pathPrefix: z.string().nullish()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  let res
  try {
    res = await reassignSessions(body.ids, { projectSlug: body.project, pathPrefix: body.pathPrefix ?? null })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw createError({ statusCode: msg.includes('not found') ? 404 : 400, statusMessage: msg })
  }
  for (const id of body.ids) {
    publishChange({ resource: 'session', action: 'updated', id })
    publishChange({ resource: 'memory', action: 'updated', id })
  }
  for (const slug of new Set([...res.froms.filter((s): s is string => !!s), res.to])) {
    publishChange({ resource: 'project', action: 'updated', id: slug })
  }
  return { ok: true, count: body.ids.length, ...res }
})
```

- [ ] **Step 5: Add composable mutation functions**

In `app/composables/useSessions.ts`, inside `useSessions()` add (near the other `$fetch` helpers):

```ts
  const reassign = (id: string, body: { project: string, pathPrefix?: string | null }) =>
    $fetch<{ ok: true, from: string | null, to: string }>(`/api/sessions/${id}`, { method: 'PATCH', body })
  const reassignMany = (body: { ids: string[], project: string, pathPrefix?: string | null }) =>
    $fetch<{ ok: true, count: number }>(`/api/sessions/reassign`, { method: 'POST', body })
```

and add them to the returned object:

```ts
  return { list, useSessionList, useSessionMeta, useSessionMessages, getMessages, reassign, reassignMany }
```

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck` → PASS.
Run: `pnpm build` → succeeds (proves the new Nitro routes compile).

- [ ] **Step 7: Verify the API end-to-end (authenticated fetch)**

Invoke the `browser-testing` skill and use its authenticated `eval`+`fetch` fixture pattern against the running dev server. Steps:
- Pick an existing session id and note its current `project` (GET `/api/sessions/:id`).
- `PATCH /api/sessions/:id` with `{ project: 'uncategorized', pathPrefix: '/tmp/plan-probe' }`; assert `res.ok === true`.
- GET `/api/sessions/:id` → assert `project === 'uncategorized'`.
- GET `/api/projects` → assert the target project's `pathPrefixes` contains `/tmp/plan-probe`.
- (If the session has agent memories) query the project's `memoryCount` moved accordingly.
- Reassign it back to its original project to leave data clean.

- [ ] **Step 8: Commit**

```bash
git add server/services/sessions.ts server/api/sessions/\[id\].patch.ts server/api/sessions/reassign.post.ts app/composables/useSessions.ts
git commit -m "feat(sessions): reassign service + PATCH/bulk endpoints + composable (memory cascade + prefix register)
<trailers>"
```

---

### Task 6: Reassignment UI (modal + detail selector + list bulk)

**Files:**
- Create: `app/components/sessions/ReassignProjectModal.vue`
- Modify: `app/pages/sessions/[id].vue` (project badge → badge + edit button + modal)
- Modify: `app/pages/sessions/index.vue` (row checkboxes + selection bar + modal)

**Interfaces:**
- Consumes: `useSessions().reassign`/`reassignMany`; `useProjects().useProjectList`/`create`; `SessionListItem`/`SessionMeta`.
- Produces: `<ReassignProjectModal v-model:open sessionIds currentCwd currentProject @done />`.

- [ ] **Step 1: Build the modal**

Create `app/components/sessions/ReassignProjectModal.vue`. Invoke `nuxt-ui-docs` first to confirm `UModal`, `USelectMenu`, `USwitch`, `UInput` v4 APIs. Implementation:

```vue
<script setup lang="ts">
import { normalizePrefix, basenameOf } from '~~/server/lib/projects/path-routing'

const props = defineProps<{
  open: boolean
  sessionIds: string[]
  currentCwd?: string | null
  currentProject?: string | null
}>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()

const { reassign, reassignMany } = useSessions()
const { useProjectList, create } = useProjects()
const { data: projects } = useProjectList()
const toast = useToast()

const CREATE = '__create__'
const selected = ref<string>('')          // project slug, or CREATE sentinel
const newName = ref('')
const registerPrefix = ref(false)
const prefix = ref('')
const busy = ref(false)

// Pre-fill the prefix from the cwd (routing is opt-in via the switch).
watch(() => props.open, (o) => {
  if (!o) return
  selected.value = props.currentProject && props.currentProject !== 'uncategorized' ? props.currentProject : ''
  newName.value = ''
  registerPrefix.value = false
  prefix.value = props.currentCwd ? normalizePrefix(props.currentCwd) : ''
})

const projectItems = computed(() => [
  ...(projects.value ?? []).map(p => ({ label: p.name || p.slug, value: p.slug })),
  { label: '➕ Create new project…', value: CREATE }
])
const isCreate = computed(() => selected.value === CREATE)
const canSubmit = computed(() =>
  (isCreate.value ? newName.value.trim().length > 0 : selected.value.length > 0) && !busy.value)

async function submit() {
  busy.value = true
  try {
    let slug = selected.value
    if (isCreate.value) {
      const proj = await create({ name: newName.value.trim() })
      slug = proj.slug
    }
    const pfx = registerPrefix.value && prefix.value.trim() ? normalizePrefix(prefix.value) : null
    if (props.sessionIds.length === 1) {
      await reassign(props.sessionIds[0]!, { project: slug, pathPrefix: pfx })
    } else {
      await reassignMany({ ids: props.sessionIds, project: slug, pathPrefix: pfx })
    }
    toast.add({ color: 'success', title: `Moved ${props.sessionIds.length} session${props.sessionIds.length > 1 ? 's' : ''}` })
    emit('update:open', false)
    emit('done')
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Reassignment failed'
    toast.add({ color: 'error', title: 'Reassignment failed', description: msg })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="sessionIds.length > 1 ? `Move ${sessionIds.length} sessions` : 'Move session to project'"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Project">
          <USelectMenu
            v-model="selected"
            :items="projectItems"
            value-key="value"
            placeholder="Select a project"
            class="w-full"
          />
        </UFormField>

        <UFormField
          v-if="isCreate"
          label="New project name"
        >
          <UInput
            v-model="newName"
            placeholder="e.g. Terawulf"
            class="w-full"
            autofocus
          />
        </UFormField>

        <div
          v-if="currentCwd"
          class="space-y-2"
        >
          <USwitch
            v-model="registerPrefix"
            :label="`Auto-route future sessions under this folder`"
          />
          <UInput
            v-if="registerPrefix"
            v-model="prefix"
            class="w-full font-mono text-xs"
          />
          <p
            v-if="registerPrefix"
            class="text-xs text-dimmed"
          >
            New no-git sessions whose folder is under this path will route here automatically.
          </p>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          label="Cancel"
          @click="emit('update:open', false)"
        />
        <UButton
          color="primary"
          label="Move"
          :loading="busy"
          :disabled="!canSubmit"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
```

> Note: importing pure helpers from `~~/server/lib/projects/path-routing` into a client component is safe — the module has no server-only imports. If the bundler objects, copy `normalizePrefix`/`basenameOf` into `app/utils/path-routing.ts` and import from there instead.

- [ ] **Step 2: Wire the modal into the session detail page**

In `app/pages/sessions/[id].vue` `<script setup>` add:

```ts
const reassignOpen = ref(false)
```

In the template, replace the `ProjectBadge` block (lines 187-190) with a badge-plus-edit affordance, and mount the modal:

```vue
                    <ProjectBadge
                      v-if="meta.project"
                      :slug="meta.project"
                    />
                    <UButton
                      icon="i-lucide-folder-input"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      :label="meta.project ? 'Move' : 'Assign project'"
                      @click="reassignOpen = true"
                    />
```

Just before the closing `</UDashboardPanel>` of the page body add:

```vue
      <ReassignProjectModal
        v-if="meta"
        v-model:open="reassignOpen"
        :session-ids="[meta.id]"
        :current-cwd="meta.cwd"
        :current-project="meta.project"
      />
```

- [ ] **Step 3: Add multi-select + bulk move to the sessions list**

In `app/pages/sessions/index.vue` `<script setup>` add:

```ts
const selectedIds = ref<Set<string>>(new Set())
const reassignOpen = ref(false)
function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedIds.value = next
}
function clearSelection() { selectedIds.value = new Set() }
const selectedList = computed(() => [...selectedIds.value])
```

In the template, add a checkbox at the start of each card's header row (guard the row click so selecting doesn't navigate). Change the card's `@click` to ignore clicks originating from the checkbox, and add:

```vue
              <UCheckbox
                :model-value="selectedIds.has(session.id)"
                class="mt-0.5"
                @click.stop
                @update:model-value="toggleSelect(session.id)"
              />
```

Add a selection action bar above the rows (after the filters block, ~line 141):

```vue
        <div
          v-if="selectedIds.size"
          class="flex items-center gap-3 rounded-lg border border-default bg-elevated/50 px-3 py-2"
        >
          <span class="text-sm text-muted">{{ selectedIds.size }} selected</span>
          <UButton
            icon="i-lucide-folder-input"
            color="primary"
            variant="soft"
            size="sm"
            label="Move to project"
            @click="reassignOpen = true"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            label="Clear"
            @click="clearSelection"
          />
        </div>
```

Mount the modal at the end of the body (bulk mode: no cwd, so the prefix control is hidden):

```vue
        <ReassignProjectModal
          v-model:open="reassignOpen"
          :session-ids="selectedList"
          :current-cwd="null"
          :current-project="null"
          @done="clearSelection"
        />
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Browser validation (playwright-cli)**

Invoke the `browser-testing` skill. With dev running + logged in:
- **Single:** open a session detail → click **Move** → pick a different project → **Move**. Assert the `ProjectBadge` updates live (no reload) and GET `/api/sessions/:id` shows the new slug.
- **Create inline:** Move → "Create new project…" → type `PlanProbe` → Move. Assert it lands on `plan-probe` and the project appears in `/projects`.
- **Prefix:** Move with the "Auto-route" switch on and a trimmed prefix; assert `/api/projects` shows the prefix in `pathPrefixes`.
- **Bulk:** on `/sessions`, filter to a hostname, tick 2+ rows → **Move to project** → pick a project → assert both rows' badges change and the selection bar clears.
- Clean up probe data.

- [ ] **Step 6: Commit**

```bash
git add app/components/sessions/ReassignProjectModal.vue app/pages/sessions/\[id\].vue app/pages/sessions/index.vue
git commit -m "feat(sessions): reassignment UI — detail selector + list bulk move + create-inline + prefix
<trailers>"
```

---

### Task 7: One-time re-resolve backfill script

**Files:**
- Create: `scripts/reresolve-uncategorized.ts`

**Interfaces:**
- Consumes: `normalizeGitRemote` (`server/lib/projects/git-remote`), `longestPrefixMatch`, `basenameOf` (`server/lib/projects/path-routing`), `slugify`.
- Produces: a CLI script; `--dry-run` prints planned moves, default applies them. Re-resolves `uncategorized`/`NULL` sessions against EXISTING projects only (never auto-creates), cascading agent memories.

- [ ] **Step 1: Write the script**

Create `scripts/reresolve-uncategorized.ts` (mirrors `scripts/backfill-projects.ts` — raw `pg`, reads `DATABASE_URL`):

```ts
// Re-resolve sessions currently in `uncategorized` (or NULL) against EXISTING
// projects only — prefix match, then cwd/git-root label, then git_remote key.
// NEVER creates a project. Cascades agent-scoped memories. Idempotent.
// Run: node_modules/.bin/tsx --env-file=.env scripts/reresolve-uncategorized.ts [--dry-run]
import { Client } from 'pg'
import { normalizeGitRemote } from '../server/lib/projects/git-remote'
import { longestPrefixMatch, basenameOf } from '../server/lib/projects/path-routing'
import { slugify } from '../shared/utils/slugify'

const DRY = process.argv.includes('--dry-run')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL')
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const { rows: projs } = await db.query(
  `select id, slug, name, git_remote_key, path_prefixes, aliases from projects`)
const prefixCands = projs.map(p => ({ id: p.id, slug: p.slug, prefixes: p.path_prefixes ?? [] }))

function matchLabel(label: string | null): { id: string, slug: string } | null {
  if (!label) return null
  const ls = slugify(label)
  const hit = projs.find(p =>
    p.slug === label || p.slug === ls ||
    (p.aliases ?? []).includes(label) || (p.aliases ?? []).includes(ls))
  return hit ? { id: hit.id, slug: hit.slug } : null
}

function resolve(cwd: string | null, gitRemote: string | null): { id: string, slug: string } | null {
  const key = normalizeGitRemote(gitRemote)
  if (key) {
    const hit = projs.find(p => p.git_remote_key === key || (p.aliases ?? []).includes(key))
    if (hit) return { id: hit.id, slug: hit.slug }
  }
  if (cwd) {
    const pfx = longestPrefixMatch(cwd, prefixCands)
    if (pfx) return { id: pfx.id, slug: pfx.slug }
    const byLeaf = matchLabel(basenameOf(cwd))
    if (byLeaf) return byLeaf
  }
  return null
}

const { rows: sess } = await db.query(
  `select id, cwd, git_remote, project from sessions
   where project is null or project = 'uncategorized'`)

let moved = 0
for (const s of sess) {
  const hit = resolve(s.cwd, s.git_remote)
  if (!hit || hit.slug === s.project) continue
  console.log(`${DRY ? '[dry] ' : ''}${s.id}  ${s.project ?? 'NULL'} -> ${hit.slug}   (${s.cwd ?? ''})`)
  if (!DRY) {
    await db.query(`update sessions set project_id=$2, project=$3 where id=$1`, [s.id, hit.id, hit.slug])
    await db.query(
      `update memories set project_id=$2, project=$3 where session_id=$1 and scope='agent'`,
      [s.id, hit.id, hit.slug])
  }
  moved++
}
console.log(`${DRY ? '[dry] would move' : 'moved'} ${moved}/${sess.length} sessions`)
await db.end()
```

- [ ] **Step 2: Dry-run against the dev DB**

Run: `node_modules/.bin/tsx --env-file=.env scripts/reresolve-uncategorized.ts --dry-run`
Expected: prints planned moves (e.g. `finances`-basename rows) and a `[dry] would move N/M` summary, exits 0, mutates nothing. If dev has no such rows, it prints `would move 0/…` — still a valid pass (the prod run in Task 8 is the real target).

- [ ] **Step 3: Commit**

```bash
git add scripts/reresolve-uncategorized.ts
git commit -m "feat(scripts): one-time re-resolve of uncategorized sessions (existing projects only)
<trailers>"
```

---

### Task 8: End-to-end validation, wiki, handover, roadmap

**Files:**
- Modify: `docs/wiki/sessions.md`
- Modify: `docs/wiki/projects.md`
- Create: `docs/handovers/2026-07-15-session-project-reassignment.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Full gate run**

Run: `pnpm test` → all green.
Run: `pnpm typecheck` → PASS.
Run: `pnpm build` → succeeds.

- [ ] **Step 2: Full browser E2E (playwright-cli)**

Invoke `browser-testing`. Exercise the complete loop and screenshot each:
1. `/sessions` shows hostnames; hostname filter narrows to `Tony-NLS`.
2. Select several `Tony-NLS` (Terawulf) rows → **Move to project** → **Create new project** `Terawulf` → Move → badges update live.
3. Open one moved session → **Move** → toggle "Auto-route" with prefix `…/Projects/Terawulf` → Move → GET `/api/projects` shows the prefix on `terawulf`.
4. Confirm the Terawulf project dashboard `sessionCount` reflects the moved rows.

- [ ] **Step 3: Update the wiki (living "how it works today")**

In `docs/wiki/sessions.md`, add/refresh a section documenting: the ingest resolver order (remote → prefix → label(cwd, git-root) → auto-create[stoplist] → uncategorized), the `hostname` surfacing + filter, and reassignment (single/bulk, memory cascade, prefix learning). In `docs/wiki/projects.md`, document the new `path_prefixes` field (routing roots; distinct from `local_paths`) and that reassignment/auto-create write it. Bump each page's `status`/date.

- [ ] **Step 4: Write the handover**

Create `docs/handovers/2026-07-15-session-project-reassignment.md` with accurate frontmatter (date, status: shipped-pending-deploy, branch `feat/session-project-reassignment`, spec + plan links). Cover: what shipped, the resolver order, the new column + migration number, the reassign endpoints, the hostname surfacing, the re-resolve script (not yet run on prod), and the deploy steps below.

- [ ] **Step 5: Update roadmap + backlog**

Add a row/entry for this work in `docs/superpowers/plans/00-roadmap.md` and reconcile `docs/BACKLOG.md` (mark the reassignment gap closed; note the prod re-resolve + Terawulf drain as the remaining operational step).

- [ ] **Step 6: Commit + finish**

```bash
git add docs/wiki/sessions.md docs/wiki/projects.md docs/handovers/2026-07-15-session-project-reassignment.md docs/superpowers/plans/00-roadmap.md docs/BACKLOG.md
git commit -m "docs: session reassignment + path-routing — wiki, handover, roadmap
<trailers>"
```

Then invoke `superpowers:finishing-a-development-branch` to choose merge/PR. **Deploy-time (per `prod-deploy` skill), post-merge:**
1. `pnpm db:migrate` runs in CD; confirm `path_prefixes` exists on prod.
2. Re-pull the hook on active machines (or accept graceful degrade of `git_root`).
3. Run `node_modules/.bin/tsx --env-file=.env scripts/reresolve-uncategorized.ts --dry-run` on prod, review, then run for real.
4. In the UI, create `Terawulf`, bulk-move its sessions, register prefix `…/Projects/Terawulf` — drains the largest cluster and validates auto-routing for future sessions.

---

## Self-Review

**Spec coverage:**
- Reassign single + bulk, create-inline → Tasks 5, 6. ✓
- Memory cascade (agent scope) → Task 5 (`applyReassign`). ✓
- `path_prefixes` column, distinct from `local_paths` → Task 2. ✓
- Resolver order: prefix → label(cwd, git-root) → auto-create[stoplist] → uncategorized → Task 3. ✓
- Stoplist (home/temp/generic leaves) → Task 1 (`isAutoCreatable`). ✓
- `git_root` from hook → route → resolver → Task 3. ✓
- Live emits (session + old/new project + memory) → Task 5 endpoints. ✓
- Hostname surfacing + filter → Task 4. ✓
- Re-resolve backfill (existing projects only, no auto-create) → Task 7. ✓
- Wiki + handover + roadmap → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step carries full code; test steps carry assertions or concrete browser/fetch procedures. (DB-orchestration tasks are honestly marked browser-verified, per repo test idiom.) ✓

**Type consistency:** `findOrCreateProject({ gitRemote, cwd, gitRoot })`, `UpsertSessionInput.gitRoot`, `reassignSession → {from,to}`, `reassignSessions → {froms,to}`, composable `reassign`/`reassignMany`, endpoints `{project, pathPrefix?}` / `{ids, project, pathPrefix?}`, `PrefixCandidate {id,slug,prefixes}`, `SessionListItem.hostname`, `ProjectDTO.pathPrefixes` — names match across tasks. ✓
