# Cycle 89: Guest Accounts + Voice Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tony (the single `owner`) can invite people as `guest` accounts that reach only an allow-listed playground (`/play/**`), starting with a voice page that speaks with his shared presets under a daily quota.

**Architecture:** Deny-by-default in `server/middleware/auth.ts` (a guest session may only reach `/api/auth`, `/api/play`, `/api/me`); `user.role`/`user.grants` live on the better-auth `user` table as `additionalFields` with `input: false`; invites are our own table emailed through the existing Resend helper; the guest voice route reuses the studio's render pipeline through one shared helper. Google login for guests uses a second provider id (`google-login`, openid/email/profile only) so it can never become a Bridget `connection`.

**Tech Stack:** Nuxt 4 (SPA), Nuxt UI v4, better-auth 1.6.13 (`genericOAuth`, `additionalFields`, `databaseHooks`), Drizzle + Postgres (migration 0092), vitest (`pnpm test`, `pnpm test:db`), playwright-cli.

**Spec:** `docs/superpowers/specs/2026-10-21-guest-accounts-playground-design.md`

## Global Constraints

- `pnpm` only. Gates: `pnpm test`, `pnpm typecheck`, `pnpm build` (lint is red repo-wide and not a gate).
- Migration is **0092**; generate with `pnpm db:generate`, then rename the SQL + journal `tag` to `0092_guest_accounts`; apply locally with `pnpm db:migrate`. drizzle-kit runs migrations in one transaction (no `CONCURRENTLY`).
- `ALLOW_SIGNUP` keeps exactly one job: bootstrapping the first owner. Public sign-up (`emailAndPassword.disableSignUp`) stays closed for guests; the invite-accept route creates rows server-side.
- Guests never receive: reference clips, `ref_text`, `SpeakOverrides`, rig URLs, API tokens, MCP tokens, SSE (`/api/events`), presence.
- Any "today" computation uses `getDefaultTimezone()` (`packages/core/src/lib/agent/jobs/timezone.ts`) + `dateInZone` (`lib/google/time.ts`). Prod is UTC; never slice an ISO string.
- Every server mutation that a live page reads calls `publishChange` (rule `.claude/rules/live-data.md`). The admin users page is owner-only and uses vue-query; emits are `resource: 'user'` and `'invite'` (added to `ResourceName`).
- Nuxt UI only in `.vue` files; reka-ui toggles need a real `click` in playwright-cli.
- Commit messages: no model/co-author lines beyond what the harness mandates; never reference models.

## Review Focus

1. **A guest with a leaked owner-minted `mm_` token** — tokens are owner-only by construction; the middleware test pins that an api-token request never consults role (Task 3).
2. **An MCP OAuth token issued to a guest session** (`/api/auth/mcp/authorize` is a public prefix) — the 1b branch must load the token's user and 403 a non-owner (Task 3 test `oauth token for guest user → 403`).
3. **Quota race** — two concurrent renders at `limit-1` must admit exactly one (Task 4 db test).
4. **Invite email case / reuse** — `Tony@X.com` vs `tony@x.com` must match one open invite; accepting twice returns 410 (Task 5 tests).
5. **Google callback for an uninvited email** — must not create a user (Task 10 test on the `user.create.before` hook with a `google-login` context).

---

## File Structure

**Create**
- `packages/core/src/shared/types/users.ts` — `Role`, `Feature`, `Grants`, `DEFAULT_DAILY_QUOTA`, `hasGrant`, `quotaFor`.
- `packages/core/src/db/schema/invites.ts`, `packages/core/src/db/schema/usage-counters.ts`.
- `server/db/migrations/0092_guest_accounts.sql` (+ journal/snapshot from drizzle-kit).
- `packages/core/src/lib/auth/hooks.ts` — `beforeUserCreate` (first-owner + invite gate for `google-login`), `afterUserCreate` (consume invite).
- `packages/core/src/lib/auth/google-login.ts` — `googleLoginProvider(clientId, clientSecret)` for `genericOAuth`.
- `packages/core/src/services/usage.ts` — `todayKey`, `consumeQuota`, `usageFor`.
- `packages/core/src/services/invites.ts` — invite CRUD + `acceptInviteWithPassword`.
- `packages/core/src/services/users.ts` — `listUsers`, `updateUserAccess`, `banUser`, `restoreUser`, `resetPassword`.
- `packages/core/src/lib/observability/resend-creds.ts` — `resendCreds()` (moved out of the email channel).
- `packages/core/src/lib/invites/email.ts` — `sendInviteEmail`.
- `server/lib/voice/render-wav.ts` — `renderPresetWav(event, { text, preset, refAudio, mode })` shared by studio + playground.
- `server/api/me.get.ts`, `server/api/play/presets.get.ts`, `server/api/play/voice/speak.post.ts`.
- `server/api/auth/invite/[token].get.ts`, `server/api/auth/invite/[token]/accept.post.ts`.
- `server/api/admin/users/index.get.ts`, `[id].patch.ts`, `[id]/reset-password.post.ts`, `invites/index.get.ts`, `invites/index.post.ts`, `invites/[id].delete.ts`, `invites/[id]/resend.post.ts`.
- `app/layouts/playground.vue`, `app/pages/play/index.vue`, `app/pages/play/voice.vue`, `app/pages/play/account.vue`, `app/pages/invite/[token].vue`, `app/pages/settings/users.vue`, `app/components/settings/UsersTab.vue`, `app/composables/useMe.ts`, `app/composables/useAdminUsers.ts`.
- Tests listed per task.

**Modify**
- `packages/core/src/db/schema/auth.ts` (user columns), `schema/voice-presets.ts` (`shared`), `schema/index.ts` (exports).
- `packages/core/src/lib/auth/index.ts` (additionalFields, hooks, genericOAuth), `lib/google/auth-options.ts` (hook scoped to `google`).
- `server/middleware/auth.ts`, `server/utils/auth-guard.ts`.
- `server/api/voice/speak.post.ts` (use `renderPresetWav`), `server/api/voice/presets/[id].patch.ts` + `services/voice-presets.ts` (`shared`).
- `app/lib/auth-client.ts`, `app/middleware/auth.global.ts`, `app/plugins/live.client.ts`, `app/plugins/presence.client.ts`, `app/layouts/default.vue` (nav), `app/pages/settings/voice.vue` (share toggle), `app/pages/login.vue` (Google button when configured).
- `packages/core/src/shared/types/live.ts` + `app/utils/live-dispatch.ts` (`user`, `invite` resources).
- `packages/core/src/lib/channels/email/channel.ts` (import `resendCreds`).
- `docs/wiki/auth.md`, `docs/wiki/voice-studio.md`, `docs/wiki/README.md`, new `docs/wiki/playground.md`, `docs/superpowers/plans/00-roadmap.md`, handover.

---

### Task 1: Types, schema, migration 0092

**Files:**
- Create: `packages/core/src/shared/types/users.ts`, `packages/core/src/db/schema/invites.ts`, `packages/core/src/db/schema/usage-counters.ts`, `server/db/migrations/0092_guest_accounts.sql`
- Modify: `packages/core/src/db/schema/auth.ts`, `packages/core/src/db/schema/voice-presets.ts`, `packages/core/src/db/schema/index.ts`
- Test: `test/users-types.test.ts`

**Interfaces:**
- Produces: `Role = 'owner' | 'guest'`, `Feature = 'voice'|'music'|'image'|'video'`, `Grants`, `DEFAULT_DAILY_QUOTA = 20`, `hasGrant(g: Grants, f: Feature): boolean`, `quotaFor(g: Grants): number`; tables `invites`, `usageCounters`; columns `user.role`, `user.grants`, `user.bannedAt`, `voicePresets.shared`.

- [ ] **Step 1: Write the failing test**

```ts
// test/users-types.test.ts
import { describe, it, expect } from 'vitest'
import { hasGrant, quotaFor, DEFAULT_DAILY_QUOTA } from '@mymind/core/shared/types/users'

describe('grants helpers', () => {
  it('hasGrant is false for missing and false flags', () => {
    expect(hasGrant({}, 'voice')).toBe(false)
    expect(hasGrant({ voice: false }, 'voice')).toBe(false)
    expect(hasGrant({ voice: true }, 'voice')).toBe(true)
  })
  it('quotaFor falls back to the default and rejects non-positive values', () => {
    expect(quotaFor({})).toBe(DEFAULT_DAILY_QUOTA)
    expect(quotaFor({ dailyQuota: 5 })).toBe(5)
    expect(quotaFor({ dailyQuota: 0 })).toBe(DEFAULT_DAILY_QUOTA)
    expect(quotaFor({ dailyQuota: -3 })).toBe(DEFAULT_DAILY_QUOTA)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/users-types.test.ts`
Expected: FAIL — cannot resolve `@mymind/core/shared/types/users`.

- [ ] **Step 3: Write the types**

```ts
// packages/core/src/shared/types/users.ts
// Cycle 89: who may use what. `role` decides which API surface a session reaches
// (server/middleware/auth.ts); `grants` decides which playground features a guest gets.
export type Role = 'owner' | 'guest'
export const FEATURES = ['voice', 'music', 'image', 'video'] as const
export type Feature = typeof FEATURES[number]

export interface Grants {
  voice?: boolean
  music?: boolean
  image?: boolean
  video?: boolean
  /** Renders per feature per day. Unset or non-positive → DEFAULT_DAILY_QUOTA. */
  dailyQuota?: number
}

export const DEFAULT_DAILY_QUOTA = 20

export function hasGrant(g: Grants | null | undefined, f: Feature): boolean {
  return g?.[f] === true
}

export function quotaFor(g: Grants | null | undefined): number {
  const q = g?.dailyQuota
  return typeof q === 'number' && Number.isFinite(q) && q > 0 ? Math.floor(q) : DEFAULT_DAILY_QUOTA
}

export interface MeDTO {
  id: string
  name: string
  email: string
  role: Role
  grants: Grants
  usage: Partial<Record<Feature, { used: number, limit: number }>>
}
```

- [ ] **Step 4: Add the user columns**

In `packages/core/src/db/schema/auth.ts`, extend the `user` table (add `jsonb` to the import):

```ts
import { pgTable, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core'
import type { Grants } from '../../shared/types/users'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // Cycle 89: 'owner' (Tony) | 'guest'. The middleware allow-lists guests; see shared/types/users.ts.
  role: text('role').notNull().default('guest'),
  grants: jsonb('grants').$type<Grants>().notNull().default({}),
  bannedAt: timestamp('banned_at', { withTimezone: true }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})
```

- [ ] **Step 5: Add `shared` to voice presets**

In `packages/core/src/db/schema/voice-presets.ts`, after `isDefault`:

```ts
  /** Cycle 89: visible to guest accounts on /play/voice. The clip never leaves the server either way. */
  shared: boolean('shared').notNull().default(false),
```

- [ ] **Step 6: Create the two new tables**

```ts
// packages/core/src/db/schema/invites.ts
// Cycle 89: single-use, 7-day invite links. Only the sha256 of the token is stored; the
// plaintext exists in the email and nowhere else.
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { user } from './auth'
import type { Grants } from '../../shared/types/users'

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  grants: jsonb('grants').$type<Grants>().notNull().default({}),
  invitedBy: text('invited_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedBy: text('used_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  // One OPEN invite per address; used ones may accumulate.
  uniqueIndex('invites_open_email_uq').on(t.email).where(sql`${t.usedAt} is null`)
])
export type InviteRow = typeof invites.$inferSelect
```

```ts
// packages/core/src/db/schema/usage-counters.ts
// Cycle 89: per-user, per-day, per-feature render counts. `day` is a date in the app
// timezone (getDefaultTimezone), written by services/usage.ts only.
import { pgTable, text, date, integer, primaryKey } from 'drizzle-orm/pg-core'
import { user } from './auth'

export const usageCounters = pgTable('usage_counters', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  kind: text('kind').notNull(),
  count: integer('count').notNull().default(0)
}, t => [primaryKey({ columns: [t.userId, t.day, t.kind] })])
```

Append to `packages/core/src/db/schema/index.ts`:

```ts
export * from './invites'
export * from './usage-counters'
```

- [ ] **Step 7: Generate and name the migration**

Run: `pnpm db:generate`
Then rename the generated `server/db/migrations/0092_<random>.sql` to `0092_guest_accounts.sql` and set the journal entry's `tag` to `0092_guest_accounts` in `server/db/migrations/meta/_journal.json`. Prepend to the SQL:

```sql
-- 0092: cycle 89 guest accounts. role/grants/banned_at on user, invites, usage_counters,
-- voice_presets.shared. Backfill: everyone who exists today is an owner (single-tenant until now).
```

and append after the generated statements:

```sql
UPDATE "user" SET "role" = 'owner';--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_check" CHECK ("role" IN ('owner','guest'));
```

Verify the generated file contains `ALTER TABLE "user" ADD COLUMN "role"`, `"grants"`, `"banned_at"`, `CREATE TABLE "invites"`, `CREATE TABLE "usage_counters"`, `ALTER TABLE "voice_presets" ADD COLUMN "shared"`, and the partial unique index `invites_open_email_uq`.

- [ ] **Step 8: Apply locally and run gates**

Run: `pnpm db:migrate && pnpm vitest run test/users-types.test.ts && pnpm typecheck`
Expected: migration applies; test PASS; typecheck clean. (`typecheck` will flag `toDTO` in `services/voice-presets.ts` only if it spreads the row; if it does, Task 9 handles `shared`.)

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/shared/types/users.ts packages/core/src/db/schema server/db/migrations test/users-types.test.ts
git commit -m "feat(db): migration 0092 — user role/grants/banned_at, invites, usage_counters, voice_presets.shared"
```

---

### Task 2: better-auth wiring — additional fields + first-owner hook

**Files:**
- Create: `packages/core/src/lib/auth/hooks.ts`
- Modify: `packages/core/src/lib/auth/index.ts`
- Test: `test/auth-user-hooks.test.ts`, extend `test/auth-google-wiring.test.ts`

**Interfaces:**
- Produces: `beforeUserCreate(deps)(user, ctx)` and `afterUserCreate(deps)(user, ctx)` factories; `auth.options.user.additionalFields.{role,grants,bannedAt}`.
- Consumes: `invites` service functions from Task 5 — to keep Task 2 independent, the hook takes them as injected deps (`deps.findOpenInviteByEmail`, `deps.markInviteUsed`); Task 5 wires the real ones.

- [ ] **Step 1: Write the failing hook tests**

```ts
// test/auth-user-hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { beforeUserCreate, afterUserCreate, type UserHookDeps } from '@mymind/core/lib/auth/hooks'

const base = { id: 'u1', name: 'A', email: 'A@Example.com', emailVerified: false, createdAt: new Date(), updatedAt: new Date() }
const deps = (over: Partial<UserHookDeps> = {}): UserHookDeps => ({
  countUsers: vi.fn(async () => 1),
  findOpenInviteByEmail: vi.fn(async () => null),
  markInviteUsed: vi.fn(async () => {}),
  applyGrants: vi.fn(async () => {}),
  ...over
})
const googleCtx = { path: '/oauth2/callback/google-login' } as never
const credCtx = { path: '/sign-up/email' } as never

describe('beforeUserCreate', () => {
  it('makes the very first user an owner', async () => {
    const out = await beforeUserCreate(deps({ countUsers: vi.fn(async () => 0) }))(base, credCtx)
    expect(out).toEqual({ data: { ...base, role: 'owner', grants: {} } })
  })
  it('makes every later credential user a guest', async () => {
    const out = await beforeUserCreate(deps())(base, credCtx)
    expect(out).toEqual({ data: { ...base, role: 'guest', grants: {} } })
  })
  it('refuses a google-login sign-up with no open invite', async () => {
    const out = await beforeUserCreate(deps())(base, googleCtx)
    expect(out).toBe(false)
  })
  it('accepts a google-login sign-up whose email (case-insensitive) has an open invite, with its grants', async () => {
    const find = vi.fn(async () => ({ id: 'inv1', email: 'a@example.com', grants: { voice: true } }))
    const out = await beforeUserCreate(deps({ findOpenInviteByEmail: find }))(base, googleCtx)
    expect(find).toHaveBeenCalledWith('a@example.com')
    expect(out).toEqual({ data: { ...base, role: 'guest', grants: { voice: true } } })
  })
  it('never lets an invite make an owner, even if the table is empty', async () => {
    const find = vi.fn(async () => ({ id: 'inv1', email: 'a@example.com', grants: {} }))
    const out = await beforeUserCreate(deps({ countUsers: vi.fn(async () => 0), findOpenInviteByEmail: find }))(base, googleCtx)
    expect(out).toEqual({ data: { ...base, role: 'owner', grants: {} } })
  })
})

describe('afterUserCreate', () => {
  it('consumes the open invite for a google-login user', async () => {
    const mark = vi.fn(async () => {})
    const find = vi.fn(async () => ({ id: 'inv1', email: 'a@example.com', grants: {} }))
    await afterUserCreate(deps({ findOpenInviteByEmail: find, markInviteUsed: mark }))({ ...base, role: 'guest' } as never, googleCtx)
    expect(mark).toHaveBeenCalledWith('inv1', 'u1')
  })
  it('does nothing on a credential sign-up', async () => {
    const mark = vi.fn(async () => {})
    await afterUserCreate(deps({ markInviteUsed: mark }))({ ...base, role: 'guest' } as never, credCtx)
    expect(mark).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/auth-user-hooks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hooks**

```ts
// packages/core/src/lib/auth/hooks.ts
// Cycle 89: who becomes what at user-creation time.
//  - The FIRST user ever is the owner (ALLOW_SIGNUP bootstrap). Everyone after is a guest.
//  - A google-login sign-up (generic-oauth provider 'google-login') is allowed only when an
//    open invite matches the Google email; it inherits the invite's grants and consumes it.
//  - Credential sign-ups via the invite-accept route set grants themselves (services/invites.ts).
import type { Grants } from '../../shared/types/users'

export interface OpenInvite { id: string, email: string, grants: Grants }
export interface UserHookDeps {
  countUsers: () => Promise<number>
  findOpenInviteByEmail: (emailLower: string) => Promise<OpenInvite | null>
  markInviteUsed: (inviteId: string, userId: string) => Promise<void>
  applyGrants: (userId: string, grants: Grants) => Promise<void>
}
type HookUser = { id: string, email: string } & Record<string, unknown>
type HookCtx = { path?: string } | null

export const GOOGLE_LOGIN_CALLBACK = '/oauth2/callback/google-login'
const isGoogleLogin = (ctx: HookCtx) => ctx?.path === GOOGLE_LOGIN_CALLBACK

export function beforeUserCreate(deps: UserHookDeps) {
  return async (user: HookUser, ctx: HookCtx): Promise<false | { data: HookUser }> => {
    if ((await deps.countUsers()) === 0) return { data: { ...user, role: 'owner', grants: {} } }
    if (isGoogleLogin(ctx)) {
      const inv = await deps.findOpenInviteByEmail(user.email.toLowerCase())
      if (!inv) return false
      return { data: { ...user, role: 'guest', grants: inv.grants } }
    }
    return { data: { ...user, role: 'guest', grants: {} } }
  }
}

export function afterUserCreate(deps: UserHookDeps) {
  return async (user: HookUser, ctx: HookCtx): Promise<void> => {
    if (!isGoogleLogin(ctx)) return
    const inv = await deps.findOpenInviteByEmail(user.email.toLowerCase())
    if (inv) await deps.markInviteUsed(inv.id, user.id)
  }
}
```

- [ ] **Step 4: Run the hook tests**

Run: `pnpm vitest run test/auth-user-hooks.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire additionalFields + hooks into `buildAuth`**

In `packages/core/src/lib/auth/index.ts`:

```ts
import { count } from 'drizzle-orm'
import { beforeUserCreate, afterUserCreate, type UserHookDeps } from './hooks'

// Real deps. Invite functions are imported lazily so lib/auth has no load-order dependency on
// services/invites (which imports lib/auth for the password hasher).
const userHookDeps: UserHookDeps = {
  countUsers: async () => Number((await useDb().select({ n: count() }).from(user))[0]?.n ?? 0),
  findOpenInviteByEmail: async (email) => (await import('../../services/invites')).findOpenInviteByEmail(email),
  markInviteUsed: async (id, userId) => (await import('../../services/invites')).markInviteUsed(id, userId),
  applyGrants: async (userId, grants) => { await useDb().update(user).set({ grants }).where(eq(user.id, userId)) }
}
```

Inside `betterAuth({...})` add:

```ts
    user: {
      additionalFields: {
        // input:false — no sign-up/update body can set these; only our hooks and admin routes.
        role: { type: 'string', required: false, defaultValue: 'guest', input: false },
        grants: { type: 'json', required: false, defaultValue: {}, input: false },
        bannedAt: { type: 'date', required: false, input: false }
      }
    },
```

and extend `databaseHooks`:

```ts
    databaseHooks: {
      user: {
        create: {
          before: async (u, ctx) => beforeUserCreate(userHookDeps)(u as never, ctx as never),
          after: async (u, ctx) => afterUserCreate(userHookDeps)(u as never, ctx as never)
        }
      },
      account: { /* unchanged */ }
    },
```

Task 5 creates `services/invites.ts`; until then add a minimal stub there exporting `findOpenInviteByEmail = async () => null` and `markInviteUsed = async () => {}` so typecheck passes (Task 5 replaces it).

- [ ] **Step 6: Extend the wiring test**

Append to `test/auth-google-wiring.test.ts` (inside its existing `describe`, using its `auth`):

```ts
  it('cycle 89: role/grants/bannedAt are additional user fields that no input can set', () => {
    const f = auth.options.user?.additionalFields as Record<string, { input?: boolean, defaultValue?: unknown }>
    expect(f.role).toMatchObject({ input: false, defaultValue: 'guest' })
    expect(f.grants).toMatchObject({ input: false })
    expect(f.bannedAt).toMatchObject({ input: false })
  })
```

Run: `pnpm vitest run test/auth-google-wiring.test.ts test/auth-user-hooks.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/lib/auth packages/core/src/services/invites.ts test/auth-user-hooks.test.ts test/auth-google-wiring.test.ts
git commit -m "feat(auth): role/grants additional fields, first-owner + invite-gated user hooks"
```

---

### Task 3: Deny-by-default middleware + `requireOwner` / `requireGrant`

**Files:**
- Modify: `server/middleware/auth.ts`, `server/utils/auth-guard.ts`
- Test: `test/auth-middleware-guest.test.ts`, extend `test/auth-guard.test.ts`

**Interfaces:**
- Produces: `GUEST_PREFIXES` (exported for tests), `event.context.user` now carries `role`, `grants`, `bannedAt`; `requireOwner(event)`, `requireGrant(event, feature)` (403 on miss) in `auth-guard.ts`; `ClientContext.role?: Role`.

- [ ] **Step 1: Write the failing middleware test**

```ts
// test/auth-middleware-guest.test.ts
// Guests may reach only GUEST_PREFIXES; owners are unaffected; api-tokens never consult role;
// an MCP OAuth token whose user is not an owner is refused (the authorize page is public).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRequestURL', (e: { url: string }) => new URL(e.url, 'http://localhost'))
vi.stubGlobal('getHeader', (e: { headers: Record<string, string> }, k: string) => e.headers[k])
vi.stubGlobal('setResponseHeader', () => {})
vi.stubGlobal('useRuntimeConfig', () => ({ betterAuthUrl: 'http://localhost:3000' }))

const getSession = vi.fn()
const getMcpSession = vi.fn()
vi.stubGlobal('useAuth', () => ({ api: { getSession, getMcpSession } }))

const selectRows = vi.fn(async () => [] as unknown[])
vi.mock('@mymind/core/db', () => ({
  useDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: selectRows }) }) }),
    update: () => ({ set: () => ({ where: () => ({ execute: async () => {} }) }) })
  })
}))
vi.mock('@mymind/core/utils/oauth-metadata', () => ({ isOauthTokenLive: () => true, mcpAuthChallengeHeader: () => 'x', oauthOrigin: () => 'http://localhost:3000' }))

const mw = (await import('../server/middleware/auth')).default as (e: unknown) => Promise<void>
const evt = (url: string, headers: Record<string, string> = {}) => ({ url, headers: { ...headers }, context: {} as Record<string, unknown> })
const user = (over: Record<string, unknown>) => ({ id: 'u1', email: 'g@x.com', role: 'guest', grants: {}, bannedAt: null, ...over })

beforeEach(() => { getSession.mockReset(); getMcpSession.mockReset(); selectRows.mockReset(); selectRows.mockResolvedValue([]) })

describe('guest allow-list', () => {
  it('guest session → 403 on an owner route', async () => {
    getSession.mockResolvedValue({ user: user({}) })
    await expect(mw(evt('/api/documents'))).rejects.toMatchObject({ statusCode: 403 })
  })
  it.each(['/api/play/presets', '/api/me', '/api/play/voice/speak'])('guest session → allowed on %s', async (url) => {
    getSession.mockResolvedValue({ user: user({}) })
    const e = evt(url)
    await expect(mw(e)).resolves.toBeUndefined()
    expect(e.context.client).toMatchObject({ type: 'session', userId: 'u1', role: 'guest' })
  })
  it.each(['/api/events', '/api/presence', '/api/settings/tokens', '/api/voice/speak'])('guest session → 403 on %s', async (url) => {
    getSession.mockResolvedValue({ user: user({}) })
    await expect(mw(evt(url))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('owner session → allowed everywhere', async () => {
    getSession.mockResolvedValue({ user: user({ role: 'owner' }) })
    await expect(mw(evt('/api/documents'))).resolves.toBeUndefined()
  })
  it('banned user → 403 even on a guest route', async () => {
    getSession.mockResolvedValue({ user: user({ bannedAt: new Date() }) })
    await expect(mw(evt('/api/me'))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('api-token request never consults the session or role', async () => {
    selectRows.mockResolvedValueOnce([{ id: 't1' }])
    const e = evt('/api/documents', { authorization: 'Bearer mm_abc' })
    await expect(mw(e)).resolves.toBeUndefined()
    expect(getSession).not.toHaveBeenCalled()
  })
  it('oauth token for a guest user → 403 on /api/mcp', async () => {
    getMcpSession.mockResolvedValue({ id: 'tok', userId: 'u1', accessTokenExpiresAt: new Date(Date.now() + 1e6) })
    selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ role: 'guest' }])
    await expect(mw(evt('/api/mcp', { authorization: 'Bearer eyJ' }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('oauth token for the owner → allowed on /api/mcp', async () => {
    getMcpSession.mockResolvedValue({ id: 'tok', userId: 'u1', accessTokenExpiresAt: new Date(Date.now() + 1e6) })
    selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ role: 'owner' }])
    await expect(mw(evt('/api/mcp', { authorization: 'Bearer eyJ' }))).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/auth-middleware-guest.test.ts`
Expected: FAIL — guest 403 cases resolve instead of rejecting; `role` missing on context.

- [ ] **Step 3: Implement the middleware changes**

In `server/middleware/auth.ts`, add the import `import { user as userTable } from '@mymind/core/db/schema'` and:

```ts
// Cycle 89: a GUEST session reaches only these. Everything else is owner-only by default — a
// route nobody thought about 403s a guest rather than leaking Tony's data.
export const GUEST_PREFIXES = ['/api/auth', '/api/play', '/api/me']
const guestAllowed = (url: string) => GUEST_PREFIXES.some(p => url === p || url.startsWith(p + '/'))
const forbidden = (msg: string) => createError({ statusCode: 403, statusMessage: msg })
```

In branch 1b (OAuth), after `isOauthTokenLive(...)` passes and before `return`:

```ts
        // The MCP authorize/consent pages sit under the public /api/auth prefix, so a guest can
        // mint an OAuth token. The token itself must not reach owner data.
        const [u] = oauthToken.userId
          ? await db.select({ role: userTable.role }).from(userTable).where(eq(userTable.id, oauthToken.userId)).limit(1)
          : []
        if (u?.role !== 'owner') throw forbidden('Forbidden: owner only')
```

(`db` is already in scope from branch 1; `eq` is imported.) In branch 2 (session), replace the body:

```ts
  if (session?.user) {
    const u = session.user as typeof session.user & { role?: string, grants?: unknown, bannedAt?: Date | string | null }
    if (u.bannedAt) throw forbidden('Forbidden: account revoked')
    const role = u.role === 'owner' ? 'owner' : 'guest'
    if (role !== 'owner' && !guestAllowed(url)) throw forbidden('Forbidden: owner only')
    event.context.user = u
    event.context.client = { type: 'session', userId: u.id, role }
    return
  }
```

- [ ] **Step 4: Extend `auth-guard.ts`**

```ts
import type { Feature, Grants, Role } from '@mymind/core/shared/types/users'
import { hasGrant } from '@mymind/core/shared/types/users'

export interface ClientContext {
  type?: 'session' | 'api-token' | 'oauth'
  userId?: string
  tokenId?: string
  /** Cycle 89: set for session clients only. */
  role?: Role
}

/** Pure predicate: a web session whose user is the owner. */
export function isOwnerClient(client: ClientContext | undefined): boolean {
  return client?.type === 'session' && client.role === 'owner'
}

/** 403 unless an OWNER web session. Admin routes and anything that edits what guests may use. */
export function requireOwner(event: H3Event): void {
  if (!isOwnerClient(event.context.client as ClientContext | undefined)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden: owner only' })
  }
}

/** 403 unless a session whose user holds the grant (owners implicitly hold every grant). Returns the user id. */
export function requireGrant(event: H3Event, feature: Feature): string {
  const client = event.context.client as ClientContext | undefined
  if (!isSessionClient(client) || !client?.userId) throw createError({ statusCode: 403, statusMessage: 'Forbidden: session required' })
  if (client.role === 'owner') return client.userId
  const grants = (event.context.user as { grants?: Grants } | undefined)?.grants
  if (!hasGrant(grants, feature)) throw createError({ statusCode: 403, statusMessage: `Forbidden: ${feature} not granted` })
  return client.userId
}
```

Append to `test/auth-guard.test.ts`:

```ts
import { isOwnerClient, requireGrant } from '../server/utils/auth-guard'

describe('cycle 89 guards', () => {
  it('isOwnerClient needs a session AND the owner role', () => {
    expect(isOwnerClient({ type: 'session', role: 'owner' })).toBe(true)
    expect(isOwnerClient({ type: 'session', role: 'guest' })).toBe(false)
    expect(isOwnerClient({ type: 'api-token' })).toBe(false)
  })
  it('requireGrant: owner passes, granted guest passes, ungranted guest 403s', () => {
    const ev = (client: unknown, grants: unknown) => ({ context: { client, user: { grants } } }) as never
    expect(requireGrant(ev({ type: 'session', userId: 'o', role: 'owner' }, {}), 'voice')).toBe('o')
    expect(requireGrant(ev({ type: 'session', userId: 'g', role: 'guest' }, { voice: true }), 'voice')).toBe('g')
    expect(() => requireGrant(ev({ type: 'session', userId: 'g', role: 'guest' }, {}), 'voice')).toThrow(/not granted/)
    expect(() => requireGrant(ev({ type: 'api-token' }, {}), 'voice')).toThrow(/session required/)
  })
})
```

(`test/auth-guard.test.ts` already stubs `createError`; if not, add the same `vi.stubGlobal('createError', …)` line used in the middleware test.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run test/auth-middleware-guest.test.ts test/auth-guard.test.ts test/agent-wake-route.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/middleware/auth.ts server/utils/auth-guard.ts test/auth-middleware-guest.test.ts test/auth-guard.test.ts
git commit -m "feat(auth): deny-by-default guest allow-list, owner-only OAuth tokens, requireOwner/requireGrant"
```

---

### Task 4: Usage counters service (atomic daily quota)

**Files:**
- Create: `packages/core/src/services/usage.ts`
- Test: `test/usage-today-key.test.ts`, `server/api/play/usage-quota.db.test.ts`

**Interfaces:**
- Produces: `todayKey(now?: Date): Promise<string>` (YYYY-MM-DD in the app zone), `consumeQuota(userId, kind: Feature, limit: number): Promise<{ ok: true, used: number } | { ok: false, used: number, limit: number, resetsAt: string }>`, `usageFor(userId, grants): Promise<MeDTO['usage']>`.

- [ ] **Step 1: Write the failing pure test**

```ts
// test/usage-today-key.test.ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('@mymind/core/lib/agent/jobs/timezone', () => ({ getDefaultTimezone: async () => 'America/Chicago' }))
const { todayKey, nextMidnightIso } = await import('@mymind/core/services/usage')

describe('todayKey', () => {
  it('uses the app timezone, not UTC (03:00Z on the 2nd is still the 1st in Chicago)', async () => {
    expect(await todayKey(new Date('2026-10-02T03:00:00Z'))).toBe('2026-10-01')
  })
  it('nextMidnightIso is the next local midnight as an ISO instant', async () => {
    // 2026-10-01 in Chicago is CDT (UTC-5): local midnight of the 2nd = 05:00Z
    expect(await nextMidnightIso(new Date('2026-10-02T03:00:00Z'))).toBe('2026-10-02T05:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/usage-today-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// packages/core/src/services/usage.ts
// Cycle 89: per-day render quotas for guests. One atomic UPSERT per consume so two parallel
// renders at limit-1 admit exactly one. "Today" is the app timezone (prod is UTC).
import { sql, eq, and } from 'drizzle-orm'
import { useDb } from '../db'
import { usageCounters } from '../db/schema'
import { getDefaultTimezone } from '../lib/agent/jobs/timezone'
import { dateInZone } from '../lib/google/time'
import { FEATURES, hasGrant, quotaFor, type Feature, type Grants, type MeDTO } from '../shared/types/users'

export async function todayKey(now = new Date()): Promise<string> {
  return dateInZone(now, await getDefaultTimezone())
}

/** The instant the current local day ends, as ISO — shown to a guest at the quota wall. */
export async function nextMidnightIso(now = new Date()): Promise<string> {
  const tz = await getDefaultTimezone()
  const today = dateInZone(now, tz)
  // Walk forward from the UTC midnight after `today` until the zone's date advances.
  let t = Date.parse(`${today}T00:00:00Z`) - 24 * 3600_000
  while (dateInZone(new Date(t), tz) <= today) t += 15 * 60_000
  return new Date(t).toISOString()
}

export async function consumeQuota(userId: string, kind: Feature, limit: number):
  Promise<{ ok: true, used: number } | { ok: false, used: number, limit: number, resetsAt: string }> {
  const day = await todayKey()
  const r = await useDb().execute(sql`
    insert into usage_counters (user_id, day, kind, count) values (${userId}, ${day}::date, ${kind}, 1)
    on conflict (user_id, day, kind) do update set count = usage_counters.count + 1
    where usage_counters.count < ${limit}
    returning count`)
  const row = r.rows[0] as { count: number } | undefined
  if (row) return { ok: true, used: Number(row.count) }
  return { ok: false, used: limit, limit, resetsAt: await nextMidnightIso() }
}

export async function usageFor(userId: string, grants: Grants): Promise<MeDTO['usage']> {
  const day = await todayKey()
  const rows = await useDb().select({ kind: usageCounters.kind, count: usageCounters.count })
    .from(usageCounters).where(and(eq(usageCounters.userId, userId), eq(usageCounters.day, day)))
  const limit = quotaFor(grants)
  const out: MeDTO['usage'] = {}
  for (const f of FEATURES) {
    if (!hasGrant(grants, f)) continue
    out[f] = { used: rows.find(r => r.kind === f)?.count ?? 0, limit }
  }
  return out
}
```

- [ ] **Step 4: Run the pure test**

Run: `pnpm vitest run test/usage-today-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the DB race test**

```ts
// server/api/play/usage-quota.db.test.ts
// Real dev DB (pattern: server/api/voice/speak-overrides.db.test.ts). Two parallel consumes
// at limit-1 must admit exactly one — the quota is the only thing between a guest and the GPU.
process.loadEnvFile('.env')
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { user, usageCounters } from '@mymind/core/db/schema'
import { consumeQuota, usageFor } from '@mymind/core/services/usage'

const uid = 'test-usage-user'
beforeEach(async () => {
  await useDb().delete(usageCounters).where(eq(usageCounters.userId, uid))
  await useDb().insert(user).values({ id: uid, name: 'test', email: 'test-usage@example.com', role: 'guest', grants: { voice: true, dailyQuota: 2 } }).onConflictDoNothing()
})
afterAll(async () => { await useDb().delete(user).where(eq(user.id, uid)) })

describe('consumeQuota', () => {
  it('admits up to the limit, then refuses with resetsAt', async () => {
    expect(await consumeQuota(uid, 'voice', 2)).toMatchObject({ ok: true, used: 1 })
    expect(await consumeQuota(uid, 'voice', 2)).toMatchObject({ ok: true, used: 2 })
    const r = await consumeQuota(uid, 'voice', 2)
    expect(r).toMatchObject({ ok: false, used: 2, limit: 2 })
    expect((r as { resetsAt: string }).resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await usageFor(uid, { voice: true, dailyQuota: 2 })).toEqual({ voice: { used: 2, limit: 2 } })
  })
  it('two parallel consumes at limit-1 admit exactly one', async () => {
    await consumeQuota(uid, 'voice', 2)
    const [a, b] = await Promise.all([consumeQuota(uid, 'voice', 2), consumeQuota(uid, 'voice', 2)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })
})
```

- [ ] **Step 6: Run the DB test**

Run: `pnpm vitest run --config vitest.db.config.ts server/api/play/usage-quota.db.test.ts`
Expected: PASS (needs the dev DB from `.env`, migrated in Task 1).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/usage.ts test/usage-today-key.test.ts server/api/play/usage-quota.db.test.ts
git commit -m "feat(usage): atomic per-day feature quotas in the app timezone"
```

---

### Task 5: Invites service + invite email

**Files:**
- Create: `packages/core/src/services/invites.ts` (replaces the Task 2 stub), `packages/core/src/lib/observability/resend-creds.ts`, `packages/core/src/lib/invites/email.ts`
- Modify: `packages/core/src/lib/channels/email/channel.ts` (import `resendCreds`)
- Test: `test/invites-service.test.ts`, `test/invite-email.test.ts`

**Interfaces:**
- Produces:
  - `createInvite({ email, grants, invitedBy }): Promise<{ invite: InviteRow, token: string }>`
  - `findOpenInviteByToken(token): Promise<InviteRow | null>` (open = unused and unexpired)
  - `findOpenInviteByEmail(emailLower): Promise<InviteRow | null>`
  - `markInviteUsed(id, userId): Promise<void>`, `listInvites(): Promise<InviteRow[]>` (open only), `cancelInvite(id)`, `rotateInviteToken(id): Promise<string>`
  - `acceptInviteWithPassword({ token, name, password }): Promise<{ userId: string, email: string }>` — 410 `InviteError('gone')` when invalid
  - `inviteLink(token): string`, `sendInviteEmail({ to, link, invitedByName }): Promise<'sent' | 'no-resend'>`
  - `resendCreds(): Promise<{ apiKey, from } | null>`

- [ ] **Step 1: Write the failing service tests (db mocked)**

```ts
// test/invites-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const state: { rows: Record<string, unknown>[] } = { rows: [] }
const insertValues = vi.fn(async (v: Record<string, unknown>) => { const row = { id: 'inv-' + state.rows.length, usedAt: null, createdAt: new Date(), ...v }; state.rows.push(row); return [row] })
vi.mock('@mymind/core/db', () => ({
  useDb: () => ({
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: () => insertValues(v) }) }),
    select: () => ({ from: () => ({ where: (pred: { __match: (r: Record<string, unknown>) => boolean }) => ({ limit: async () => state.rows.filter(pred.__match).slice(0, 1), orderBy: async () => state.rows.filter(pred.__match) }) }) }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async (pred: { __match: (r: Record<string, unknown>) => boolean }) => { state.rows.filter(pred.__match).forEach(r => Object.assign(r, patch)) } }) })
  })
}))
// The service builds predicates through a tiny internal helper (openInviteWhere) so this test can
// substitute matching without reimplementing drizzle; see Step 3.
vi.mock('@mymind/core/services/invites-where', () => ({
  byTokenHash: (h: string) => ({ __match: (r: Record<string, unknown>) => r.tokenHash === h && !r.usedAt && (r.expiresAt as Date) > new Date() }),
  byOpenEmail: (e: string) => ({ __match: (r: Record<string, unknown>) => r.email === e && !r.usedAt && (r.expiresAt as Date) > new Date() }),
  byId: (id: string) => ({ __match: (r: Record<string, unknown>) => r.id === id }),
  allOpen: () => ({ __match: (r: Record<string, unknown>) => !r.usedAt })
}))

const svc = await import('@mymind/core/services/invites')
beforeEach(() => { state.rows = []; insertValues.mockClear() })

describe('invites service', () => {
  it('createInvite lower-cases the email, stores only the sha256 of the token, expires in 7 days', async () => {
    const { invite, token } = await svc.createInvite({ email: 'Tony@X.com', grants: { voice: true }, invitedBy: 'owner' })
    expect(invite.email).toBe('tony@x.com')
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(invite.tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
    const days = ((invite.expiresAt as Date).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThan(7.1)
  })
  it('findOpenInviteByToken finds by plaintext token and ignores used/expired ones', async () => {
    const { invite, token } = await svc.createInvite({ email: 'a@x.com', grants: {}, invitedBy: 'owner' })
    expect((await svc.findOpenInviteByToken(token))?.id).toBe(invite.id)
    await svc.markInviteUsed(invite.id, 'u9')
    expect(await svc.findOpenInviteByToken(token)).toBeNull()
  })
  it('findOpenInviteByEmail is case-insensitive', async () => {
    await svc.createInvite({ email: 'B@X.com', grants: {}, invitedBy: 'owner' })
    expect(await svc.findOpenInviteByEmail('b@x.com')).not.toBeNull()
  })
  it('rotateInviteToken replaces the hash and returns a new plaintext token', async () => {
    const { invite, token } = await svc.createInvite({ email: 'c@x.com', grants: {}, invitedBy: 'owner' })
    const t2 = await svc.rotateInviteToken(invite.id)
    expect(t2).not.toBe(token)
    expect(await svc.findOpenInviteByToken(token)).toBeNull()
    expect((await svc.findOpenInviteByToken(t2))?.id).toBe(invite.id)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/invites-service.test.ts`
Expected: FAIL — `createInvite` is not exported by the stub.

- [ ] **Step 3: Implement the predicates module and the service**

```ts
// packages/core/src/services/invites-where.ts
// Drizzle predicates for invites, split out so unit tests can substitute plain matchers.
import { and, eq, gt, isNull } from 'drizzle-orm'
import { invites } from '../db/schema'
export const byTokenHash = (h: string) => and(eq(invites.tokenHash, h), isNull(invites.usedAt), gt(invites.expiresAt, new Date()))
export const byOpenEmail = (e: string) => and(eq(invites.email, e), isNull(invites.usedAt), gt(invites.expiresAt, new Date()))
export const byId = (id: string) => eq(invites.id, id)
export const allOpen = () => isNull(invites.usedAt)
```

```ts
// packages/core/src/services/invites.ts
// Cycle 89: single-use, 7-day invites. The plaintext token lives only in the email/link; we
// store its sha256. Accepting with a password inserts the user + credential account rows
// directly (ALLOW_SIGNUP stays closed for the public) and never grants 'owner'.
import { randomBytes, createHash } from 'node:crypto'
import { desc } from 'drizzle-orm'
import { useDb } from '../db'
import { invites, user, account, type InviteRow } from '../db/schema'
import { byTokenHash, byOpenEmail, byId, allOpen } from './invites-where'
import { useAuth } from '../lib/auth'
import { coreConfig } from '../config'
import type { Grants } from '../shared/types/users'

export const INVITE_TTL_MS = 7 * 86_400_000
export class InviteError extends Error { constructor(public code: 'gone' | 'email-taken' | 'weak-password') { super(code) } }

const newToken = () => randomBytes(32).toString('base64url')
export const hashInviteToken = (t: string) => createHash('sha256').update(t).digest('hex')

export async function createInvite(input: { email: string, grants: Grants, invitedBy: string }): Promise<{ invite: InviteRow, token: string }> {
  const token = newToken()
  const [invite] = await useDb().insert(invites).values({
    email: input.email.trim().toLowerCase(), tokenHash: hashInviteToken(token), grants: input.grants,
    invitedBy: input.invitedBy, expiresAt: new Date(Date.now() + INVITE_TTL_MS)
  }).returning()
  return { invite: invite!, token }
}

export async function findOpenInviteByToken(token: string): Promise<InviteRow | null> {
  return (await useDb().select().from(invites).where(byTokenHash(hashInviteToken(token))).limit(1))[0] ?? null
}
export async function findOpenInviteByEmail(email: string): Promise<InviteRow | null> {
  return (await useDb().select().from(invites).where(byOpenEmail(email.trim().toLowerCase())).limit(1))[0] ?? null
}
export async function findInviteById(id: string): Promise<InviteRow | null> {
  return (await useDb().select().from(invites).where(byId(id)).limit(1))[0] ?? null
}
export async function listInvites(): Promise<InviteRow[]> {
  return useDb().select().from(invites).where(allOpen()).orderBy(desc(invites.createdAt))
}
export async function markInviteUsed(id: string, userId: string): Promise<void> {
  await useDb().update(invites).set({ usedAt: new Date(), usedBy: userId }).where(byId(id))
}
export async function cancelInvite(id: string): Promise<void> {
  // Cancel = expire now; the row stays for the audit trail and the open-email index frees up.
  await useDb().update(invites).set({ expiresAt: new Date(0) }).where(byId(id))
}
export async function rotateInviteToken(id: string): Promise<string> {
  const token = newToken()
  await useDb().update(invites).set({ tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).where(byId(id))
  return token
}

export function inviteLink(token: string): string {
  const base = (coreConfig().betterAuthUrl as string | undefined) ?? 'http://localhost:3000'
  return `${new URL(base).origin}/invite/${token}`
}

/** Password path of /invite/<token>. Returns the new user; the client signs in with the same password. */
export async function acceptInviteWithPassword(input: { token: string, name: string, password: string }): Promise<{ userId: string, email: string }> {
  const inv = await findOpenInviteByToken(input.token)
  if (!inv) throw new InviteError('gone')
  const ctx = await useAuth().$context
  const { minPasswordLength, maxPasswordLength } = ctx.password.config
  if (input.password.length < minPasswordLength || input.password.length > maxPasswordLength) throw new InviteError('weak-password')
  if (await ctx.internalAdapter.findUserByEmail(inv.email)) throw new InviteError('email-taken')
  // internalAdapter.createUser runs the databaseHooks (Task 2) → role 'guest' (table is non-empty:
  // the owner exists, or nobody could have minted this invite).
  const created = await ctx.internalAdapter.createUser({ name: input.name.trim(), email: inv.email, emailVerified: true } as never)
  const hash = await ctx.password.hash(input.password)
  await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: 'credential', accountId: created.id, password: hash } as never)
  await useDb().update(user).set({ grants: inv.grants, role: 'guest' }).where(eq(user.id, created.id))
  await markInviteUsed(inv.id, created.id)
  return { userId: created.id, email: inv.email }
}
```

(Imports at the top of the file: `import { desc, eq } from 'drizzle-orm'` and `import { invites, user, type InviteRow } from '../db/schema'` — `account` is not needed; `linkAccount` writes it.)

- [ ] **Step 4: Run the service tests**

Run: `pnpm vitest run test/invites-service.test.ts test/auth-user-hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Move `resendCreds` and write the email helper + test**

```ts
// packages/core/src/lib/observability/resend-creds.ts
import { loadObsConfig } from './config'
import { decryptSecret } from '../ai/registry/crypto'
/** Resend key + sender from the alert config; null until Settings → Activity & Alerts is filled in. */
export async function resendCreds(): Promise<{ apiKey: string, from: string } | null> {
  const e = (await loadObsConfig()).alerts.email
  if (!e.apiKeyEnc || !e.from) return null
  return { apiKey: decryptSecret(e.apiKeyEnc), from: e.from }
}
```

In `packages/core/src/lib/channels/email/channel.ts`, delete the local `resendCreds` function and its `loadObsConfig`/`decryptSecret` imports, and add `import { resendCreds } from '../../observability/resend-creds'`.

```ts
// packages/core/src/lib/invites/email.ts
import { sendResendEmail } from '../observability/email'
import { resendCreds } from '../observability/resend-creds'

export function inviteEmailText(link: string, invitedByName: string): string {
  return [`${invitedByName} invited you to Bridget's playground.`, '', `Accept the invite (valid 7 days):`, link, '', `If you weren't expecting this, ignore it.`].join('\n')
}

export async function sendInviteEmail(opts: { to: string, link: string, invitedByName: string }): Promise<'sent' | 'no-resend'> {
  const creds = await resendCreds()
  if (!creds) return 'no-resend'
  await sendResendEmail({ apiKey: creds.apiKey, from: creds.from, to: opts.to, subject: `${opts.invitedByName} invited you to Bridget`, text: inviteEmailText(opts.link, opts.invitedByName) })
  return 'sent'
}
```

```ts
// test/invite-email.test.ts
import { describe, it, expect, vi } from 'vitest'
const send = vi.fn(async () => {})
vi.mock('@mymind/core/lib/observability/email', () => ({ sendResendEmail: send }))
const creds = vi.fn(async () => null as null | { apiKey: string, from: string })
vi.mock('@mymind/core/lib/observability/resend-creds', () => ({ resendCreds: creds }))
const { sendInviteEmail, inviteEmailText } = await import('@mymind/core/lib/invites/email')

describe('sendInviteEmail', () => {
  it('returns no-resend without calling Resend when unconfigured', async () => {
    expect(await sendInviteEmail({ to: 'a@x.com', link: 'http://l', invitedByName: 'Tony' })).toBe('no-resend')
    expect(send).not.toHaveBeenCalled()
  })
  it('sends with the configured sender and the link in the body', async () => {
    creds.mockResolvedValueOnce({ apiKey: 'k', from: 'bridget@x.com' })
    expect(await sendInviteEmail({ to: 'a@x.com', link: 'http://l/invite/t', invitedByName: 'Tony' })).toBe('sent')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: 'bridget@x.com', to: 'a@x.com', text: inviteEmailText('http://l/invite/t', 'Tony') }))
  })
})
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm vitest run test/invite-email.test.ts test/invites-service.test.ts && pnpm typecheck && pnpm vitest run test/channels-routes.test.ts`
Expected: PASS; the channel still builds after the `resendCreds` move.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/invites.ts packages/core/src/services/invites-where.ts packages/core/src/lib/invites packages/core/src/lib/observability/resend-creds.ts packages/core/src/lib/channels/email/channel.ts test/invites-service.test.ts test/invite-email.test.ts
git commit -m "feat(invites): invite service (hashed single-use tokens), password accept, Resend invite email"
```

---

### Task 6: Public invite routes + `/invite/[token]` page

**Files:**
- Create: `server/api/auth/invite/[token].get.ts`, `server/api/auth/invite/[token]/accept.post.ts`, `app/pages/invite/[token].vue`
- Modify: `app/middleware/auth.global.ts` (exempt `/invite/`), `app/middleware/onboarding.global.ts` (exempt `/invite/`)
- Test: `test/invite-routes.test.ts`

**Interfaces:**
- `GET /api/auth/invite/:token` → `{ email, invitedBy: string, valid: boolean }` (200 even when invalid; `valid:false` renders the dead-link state).
- `POST /api/auth/invite/:token/accept` `{ name, password }` → `{ email }`; 410 gone, 409 email-taken, 400 weak-password. The page then calls `authClient.signIn.email`.

- [ ] **Step 1: Write the failing route tests**

```ts
// test/invite-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getRouterParam', (e: { params: Record<string, string> }, k: string) => e.params[k])

const findOpenInviteByToken = vi.fn()
const acceptInviteWithPassword = vi.fn()
const inviterName = vi.fn(async () => 'Tony')
vi.mock('@mymind/core/services/invites', async () => ({
  findOpenInviteByToken, acceptInviteWithPassword,
  InviteError: class extends Error { constructor(public code: string) { super(code) } }
}))
vi.mock('@mymind/core/services/users', () => ({ userDisplayName: inviterName }))

const get = (await import('../server/api/auth/invite/[token].get')).default as (e: unknown) => Promise<unknown>
const accept = (await import('../server/api/auth/invite/[token]/accept.post')).default as (e: unknown) => Promise<unknown>
const evt = (token: string, body?: unknown) => ({ params: { token }, body, context: {} })
beforeEach(() => { findOpenInviteByToken.mockReset(); acceptInviteWithPassword.mockReset() })

describe('GET /api/auth/invite/:token', () => {
  it('describes a valid invite without leaking the hash or grants', async () => {
    findOpenInviteByToken.mockResolvedValue({ id: 'i', email: 'a@x.com', invitedBy: 'o', tokenHash: 'h', grants: { voice: true } })
    expect(await get(evt('t'))).toEqual({ valid: true, email: 'a@x.com', invitedBy: 'Tony' })
  })
  it('reports valid:false for an unknown token', async () => {
    findOpenInviteByToken.mockResolvedValue(null)
    expect(await get(evt('t'))).toEqual({ valid: false })
  })
})
describe('POST /api/auth/invite/:token/accept', () => {
  it('maps InviteError codes to statuses', async () => {
    const { InviteError } = await import('@mymind/core/services/invites')
    for (const [code, status] of [['gone', 410], ['email-taken', 409], ['weak-password', 400]] as const) {
      acceptInviteWithPassword.mockRejectedValueOnce(new InviteError(code))
      await expect(accept(evt('t', { name: 'A', password: 'x' }))).rejects.toMatchObject({ statusCode: status })
    }
  })
  it('400s on a missing name', async () => {
    await expect(accept(evt('t', { password: 'longenough1' }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('returns the email on success', async () => {
    acceptInviteWithPassword.mockResolvedValue({ userId: 'u', email: 'a@x.com' })
    expect(await accept(evt('t', { name: 'A', password: 'longenough1' }))).toEqual({ email: 'a@x.com' })
    expect(acceptInviteWithPassword).toHaveBeenCalledWith({ token: 't', name: 'A', password: 'longenough1' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/invite-routes.test.ts`
Expected: FAIL — handlers missing.

- [ ] **Step 3: Implement the routes (+ `userDisplayName` in a minimal `services/users.ts`, extended in Task 7)**

```ts
// packages/core/src/services/users.ts  (Task 7 adds the admin functions)
import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { user } from '../db/schema'
export async function userDisplayName(id: string): Promise<string> {
  const [u] = await useDb().select({ name: user.name }).from(user).where(eq(user.id, id)).limit(1)
  return u?.name ?? 'Someone'
}
```

```ts
// server/api/auth/invite/[token].get.ts
// Public (under /api/auth). Describes an invite for the accept page; never returns grants or the hash.
import { findOpenInviteByToken } from '@mymind/core/services/invites'
import { userDisplayName } from '@mymind/core/services/users'
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  const inv = await findOpenInviteByToken(token)
  if (!inv) return { valid: false as const }
  return { valid: true as const, email: inv.email, invitedBy: await userDisplayName(inv.invitedBy) }
})
```

```ts
// server/api/auth/invite/[token]/accept.post.ts
import { acceptInviteWithPassword, InviteError } from '@mymind/core/services/invites'
const STATUS: Record<InviteError['code'], number> = { gone: 410, 'email-taken': 409, 'weak-password': 400 }
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  const body = await readBody<{ name?: string, password?: string }>(event)
  const name = body?.name?.trim()
  if (!name || !body?.password) throw createError({ statusCode: 400, statusMessage: 'name and password are required' })
  try {
    const { email } = await acceptInviteWithPassword({ token, name, password: body.password })
    return { email }
  } catch (err) {
    if (err instanceof InviteError) throw createError({ statusCode: STATUS[err.code], statusMessage: err.code })
    throw err
  }
})
```

- [ ] **Step 4: Run route tests**

Run: `pnpm vitest run test/invite-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: The accept page + middleware exemptions**

In `app/middleware/auth.global.ts` change the first line of the handler to:

```ts
  if (to.path === '/login' || to.path.startsWith('/share/') || to.path.startsWith('/invite/')) return
```

In `app/middleware/onboarding.global.ts` add `|| to.path.startsWith('/invite/')` to its exemption condition the same way.

```vue
<!-- app/pages/invite/[token].vue -->
<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { authClient } from '~/lib/auth-client'
definePageMeta({ layout: false })
const route = useRoute()
const token = computed(() => String(route.params.token ?? ''))
const { data: info, status } = await useFetch(() => `/api/auth/invite/${token.value}`)
const googleEnabled = useRuntimeConfig().public.googleLogin === true
const form = reactive({ name: '', password: '' })
const busy = ref(false)
const error = ref<string | null>(null)
const fields = [
  { name: 'name', type: 'text' as const, label: 'Your name', required: true },
  { name: 'password', type: 'password' as const, label: 'Password', required: true }
]
async function onSubmit(ev: FormSubmitEvent<{ name: string, password: string }>) {
  busy.value = true; error.value = null
  try {
    const { email } = await $fetch<{ email: string }>(`/api/auth/invite/${token.value}/accept`, { method: 'POST', body: ev.data })
    const res = await authClient.signIn.email({ email, password: ev.data.password })
    if (res.error) throw new Error(res.error.message ?? 'sign-in failed')
    await navigateTo('/play')
  } catch (e) {
    const msg = (e as { statusMessage?: string, message?: string })
    error.value = msg.statusMessage === 'gone' ? 'This invite is no longer valid.'
      : msg.statusMessage === 'email-taken' ? 'An account with this email already exists — sign in instead.'
      : msg.statusMessage === 'weak-password' ? 'Password must be at least 8 characters.'
      : (msg.message ?? 'Something went wrong')
  } finally { busy.value = false }
}
function google() {
  authClient.signIn.oauth2({ providerId: 'google-login', callbackURL: '/play', errorCallbackURL: `/invite/${token.value}?error=google` })
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="text-lg font-semibold text-highlighted">You're invited to Bridget</h1>
      </template>
      <div v-if="status === 'pending'" class="text-sm text-muted">Checking your invite…</div>
      <div v-else-if="!info?.valid" class="text-sm text-muted">This invite is no longer valid. Ask for a new one.</div>
      <div v-else class="flex flex-col gap-4">
        <p class="text-sm text-muted">{{ info.invitedBy }} invited <span class="text-highlighted">{{ info.email }}</span>. Choose how you'd like to sign in.</p>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UAlert v-if="route.query.error === 'google'" color="error" variant="subtle" title="Google sign-in failed — the Google account's email must match this invite." />
        <UAuthForm :fields="fields" :state="form" :loading="busy" submit-label="Create account" @submit="onSubmit" />
        <UButton v-if="googleEnabled" variant="outline" color="neutral" icon="i-simple-icons-google" block label="Continue with Google" @click="google" />
      </div>
    </UCard>
  </div>
</template>
```

`runtimeConfig.public.googleLogin` and `authClient.signIn.oauth2` are added in Task 10; until then the button is hidden (`googleLogin` undefined → false) and the `oauth2` call type-errors. To keep this task green, **leave the `google()` function and the button out until Task 10** (Task 10's steps add them back verbatim).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add server/api/auth/invite packages/core/src/services/users.ts app/pages/invite app/middleware/auth.global.ts app/middleware/onboarding.global.ts test/invite-routes.test.ts
git commit -m "feat(invites): public invite describe/accept routes and /invite/:token page"
```

---

### Task 7: Admin users API + `/settings/users` page

**Files:**
- Modify: `packages/core/src/services/users.ts`, `packages/core/src/shared/types/live.ts`, `app/utils/live-dispatch.ts`, `app/layouts/default.vue`
- Create: `server/api/admin/users/index.get.ts`, `server/api/admin/users/[id].patch.ts`, `server/api/admin/users/[id]/reset-password.post.ts`, `server/api/admin/users/invites/index.get.ts`, `server/api/admin/users/invites/index.post.ts`, `server/api/admin/users/invites/[id].delete.ts`, `server/api/admin/users/invites/[id]/resend.post.ts`, `app/composables/useAdminUsers.ts`, `app/components/settings/UsersTab.vue`, `app/pages/settings/users.vue`
- Test: `test/admin-users-routes.test.ts`

**Interfaces:**
- `listUsers(): Promise<AdminUserDTO[]>` where `AdminUserDTO = { id, name, email, role, grants, bannedAt: string|null, createdAt: string, lastSeenAt: string|null, googleLinked: boolean, usage: MeDTO['usage'] }`
- `updateUserAccess(id, patch: { grants?: Grants, banned?: boolean }): Promise<void>` — refuses to ban or edit an `owner` (`UsersError('owner-immutable')`).
- `resetPassword(id): Promise<string>` (new temp password, 16 chars base64url, via `internalAdapter.updatePassword`).
- Routes all `requireOwner`. `POST /api/admin/users/invites` `{ email, grants }` → `{ invite, link, email: 'sent'|'no-resend' }` (the link is returned so the owner can paste it when Resend is off). Every mutation emits `publishChange({ resource: 'user' | 'invite', action, id })`.

- [ ] **Step 1: Write the failing route tests**

```ts
// test/admin-users-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getRouterParam', (e: { params: Record<string, string> }, k: string) => e.params[k])

const users = { listUsers: vi.fn(async () => []), updateUserAccess: vi.fn(async () => {}), resetPassword: vi.fn(async () => 'tmp'), userDisplayName: vi.fn(async () => 'Tony'), UsersError: class extends Error { constructor(public code: string) { super(code) } } }
vi.mock('@mymind/core/services/users', () => users)
const inv = { createInvite: vi.fn(async () => ({ invite: { id: 'i1', email: 'a@x.com' }, token: 'tok' })), inviteLink: (t: string) => `http://l/invite/${t}`, listInvites: vi.fn(async () => []), cancelInvite: vi.fn(async () => {}), rotateInviteToken: vi.fn(async () => 'tok2'), findInviteById: vi.fn(async () => ({ id: 'i1', email: 'a@x.com' })) }
vi.mock('@mymind/core/services/invites', () => inv)
const sendInviteEmail = vi.fn(async () => 'sent')
vi.mock('@mymind/core/lib/invites/email', () => ({ sendInviteEmail }))
const publishChange = vi.fn()
vi.mock('@mymind/core/utils/live-bus', () => ({ publishChange }))

const list = (await import('../server/api/admin/users/index.get')).default as (e: unknown) => Promise<unknown>
const patch = (await import('../server/api/admin/users/[id].patch')).default as (e: unknown) => Promise<unknown>
const mint = (await import('../server/api/admin/users/invites/index.post')).default as (e: unknown) => Promise<unknown>
const owner = { type: 'session', userId: 'o', role: 'owner' }
const guest = { type: 'session', userId: 'g', role: 'guest' }
const evt = (client: unknown, body?: unknown, params: Record<string, string> = {}) => ({ context: { client, user: { id: (client as { userId: string }).userId } }, body, params })
beforeEach(() => { publishChange.mockReset(); users.updateUserAccess.mockReset(); sendInviteEmail.mockReset(); sendInviteEmail.mockResolvedValue('sent') })

describe('admin users routes', () => {
  it('every route is owner-only', async () => {
    for (const h of [list, patch, mint]) await expect(h(evt(guest, {}, { id: 'x' }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(list(evt({ type: 'api-token', tokenId: 't' }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('PATCH validates grants, forwards, and emits user/updated', async () => {
    await patch(evt(owner, { grants: { voice: true, dailyQuota: 5 }, banned: false }, { id: 'u1' }))
    expect(users.updateUserAccess).toHaveBeenCalledWith('u1', { grants: { voice: true, dailyQuota: 5 }, banned: false })
    expect(publishChange).toHaveBeenCalledWith({ resource: 'user', action: 'updated', id: 'u1' })
    await expect(patch(evt(owner, { grants: { bogus: true } }, { id: 'u1' }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('PATCH maps owner-immutable to 409', async () => {
    users.updateUserAccess.mockRejectedValueOnce(new users.UsersError('owner-immutable'))
    await expect(patch(evt(owner, { banned: true }, { id: 'o' }))).rejects.toMatchObject({ statusCode: 409 })
  })
  it('mint creates, emails, returns the link, emits invite/created', async () => {
    const out = await mint(evt(owner, { email: 'A@x.com', grants: { voice: true } }))
    expect(inv.createInvite).toHaveBeenCalledWith({ email: 'A@x.com', grants: { voice: true }, invitedBy: 'o' })
    expect(sendInviteEmail).toHaveBeenCalledWith({ to: 'a@x.com', link: 'http://l/invite/tok', invitedByName: 'Tony' })
    expect(out).toEqual({ invite: { id: 'i1', email: 'a@x.com' }, link: 'http://l/invite/tok', email: 'sent' })
    expect(publishChange).toHaveBeenCalledWith({ resource: 'invite', action: 'created', id: 'i1' })
  })
  it('mint 400s on a malformed email', async () => {
    await expect(mint(evt(owner, { email: 'nope', grants: {} }))).rejects.toMatchObject({ statusCode: 400 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/admin-users-routes.test.ts`
Expected: FAIL — handlers missing.

- [ ] **Step 3: Live resource names**

In `packages/core/src/shared/types/live.ts` add `'user' | 'invite'` to the `ResourceName` union. In `app/utils/live-dispatch.ts` add entries that invalidate `['user', 'list']` and `['invite', 'list']` respectively (follow the file's existing pattern of `qc.invalidateQueries({ queryKey: [...] })`).

- [ ] **Step 4: Extend `services/users.ts`**

```ts
// packages/core/src/services/users.ts
import { eq, desc, max, inArray, and } from 'drizzle-orm'
import { useDb } from '../db'
import { user, session, account } from '../db/schema'
import { useAuth } from '../lib/auth'
import { usageFor } from './usage'
import { randomBytes } from 'node:crypto'
import type { Grants, MeDTO, Role } from '../shared/types/users'

export class UsersError extends Error { constructor(public code: 'owner-immutable' | 'not-found') { super(code) } }

export interface AdminUserDTO {
  id: string, name: string, email: string, role: Role, grants: Grants, bannedAt: string | null, createdAt: string,
  lastSeenAt: string | null, googleLinked: boolean, usage: MeDTO['usage']
}

export async function userDisplayName(id: string): Promise<string> {
  const [u] = await useDb().select({ name: user.name }).from(user).where(eq(user.id, id)).limit(1)
  return u?.name ?? 'Someone'
}

export async function listUsers(): Promise<AdminUserDTO[]> {
  const db = useDb()
  const rows = await db.select().from(user).orderBy(desc(user.createdAt))
  const ids = rows.map(r => r.id)
  const seen = ids.length ? await db.select({ userId: session.userId, at: max(session.updatedAt) }).from(session).where(inArray(session.userId, ids)).groupBy(session.userId) : []
  const google = ids.length ? await db.select({ userId: account.userId }).from(account).where(and(inArray(account.userId, ids), eq(account.providerId, 'google-login'))) : []
  return Promise.all(rows.map(async r => ({
    id: r.id, name: r.name, email: r.email, role: (r.role === 'owner' ? 'owner' : 'guest') as Role, grants: r.grants ?? {},
    bannedAt: r.bannedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    lastSeenAt: seen.find(s => s.userId === r.id)?.at?.toISOString() ?? null,
    googleLinked: google.some(g => g.userId === r.id),
    usage: r.role === 'owner' ? {} : await usageFor(r.id, r.grants ?? {})
  })))
}

export async function updateUserAccess(id: string, patch: { grants?: Grants, banned?: boolean }): Promise<void> {
  const db = useDb()
  const [u] = await db.select({ role: user.role }).from(user).where(eq(user.id, id)).limit(1)
  if (!u) throw new UsersError('not-found')
  if (u.role === 'owner') throw new UsersError('owner-immutable')
  const set: Partial<typeof user.$inferInsert> = {}
  if (patch.grants) set.grants = patch.grants
  if (patch.banned === true) set.bannedAt = new Date()
  if (patch.banned === false) set.bannedAt = null
  if (Object.keys(set).length) await db.update(user).set(set).where(eq(user.id, id))
  if (patch.banned === true) await db.delete(session).where(eq(session.userId, id))
}

export async function resetPassword(id: string): Promise<string> {
  const [u] = await useDb().select({ role: user.role }).from(user).where(eq(user.id, id)).limit(1)
  if (!u) throw new UsersError('not-found')
  if (u.role === 'owner') throw new UsersError('owner-immutable')
  const temp = randomBytes(12).toString('base64url')
  const ctx = await useAuth().$context
  await ctx.internalAdapter.updatePassword(id, await ctx.password.hash(temp))
  await useDb().delete(session).where(eq(session.userId, id))
  return temp
}
```

- [ ] **Step 5: Routes**

Shared zod for the body (inline in each route; both routes are short):

```ts
// server/api/admin/users/index.get.ts
import { requireOwner } from '../../../utils/auth-guard'
import { listUsers } from '@mymind/core/services/users'
export default defineEventHandler(async (event) => { requireOwner(event); return { users: await listUsers() } })
```

```ts
// server/api/admin/users/[id].patch.ts
import { z } from 'zod'
import { requireOwner } from '../../../utils/auth-guard'
import { updateUserAccess, UsersError } from '@mymind/core/services/users'
import { publishChange } from '@mymind/core/utils/live-bus'
export const grantsSchema = z.object({ voice: z.boolean().optional(), music: z.boolean().optional(), image: z.boolean().optional(), video: z.boolean().optional(), dailyQuota: z.number().int().positive().max(1000).optional() }).strict()
const bodySchema = z.object({ grants: grantsSchema.optional(), banned: z.boolean().optional() }).strict()
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const id = getRouterParam(event, 'id')!
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'invalid body' })
  try { await updateUserAccess(id, parsed.data) } catch (err) {
    if (err instanceof UsersError) throw createError({ statusCode: err.code === 'not-found' ? 404 : 409, statusMessage: err.code })
    throw err
  }
  publishChange({ resource: 'user', action: 'updated', id })
  return { ok: true }
})
```

```ts
// server/api/admin/users/[id]/reset-password.post.ts
import { requireOwner } from '../../../../utils/auth-guard'
import { resetPassword, UsersError } from '@mymind/core/services/users'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const id = getRouterParam(event, 'id')!
  try { return { password: await resetPassword(id) } } catch (err) {
    if (err instanceof UsersError) throw createError({ statusCode: err.code === 'not-found' ? 404 : 409, statusMessage: err.code })
    throw err
  }
})
```

```ts
// server/api/admin/users/invites/index.get.ts
import { requireOwner } from '../../../../utils/auth-guard'
import { listInvites } from '@mymind/core/services/invites'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  return { invites: (await listInvites()).map(i => ({ id: i.id, email: i.email, grants: i.grants, expiresAt: i.expiresAt, createdAt: i.createdAt })) }
})
```

```ts
// server/api/admin/users/invites/index.post.ts
import { z } from 'zod'
import { requireOwner } from '../../../../utils/auth-guard'
import { createInvite, inviteLink } from '@mymind/core/services/invites'
import { sendInviteEmail } from '@mymind/core/lib/invites/email'
import { userDisplayName } from '@mymind/core/services/users'
import { publishChange } from '@mymind/core/utils/live-bus'
import { grantsSchema } from '../[id].patch'
const bodySchema = z.object({ email: z.string().email(), grants: grantsSchema })
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'invalid body' })
  const invitedBy = (event.context.user as { id: string }).id
  const { invite, token } = await createInvite({ email: parsed.data.email, grants: parsed.data.grants, invitedBy })
  const link = inviteLink(token)
  const email = await sendInviteEmail({ to: invite.email, link, invitedByName: await userDisplayName(invitedBy) })
  publishChange({ resource: 'invite', action: 'created', id: invite.id })
  return { invite: { id: invite.id, email: invite.email }, link, email }
})
```

```ts
// server/api/admin/users/invites/[id].delete.ts
import { requireOwner } from '../../../../utils/auth-guard'
import { cancelInvite } from '@mymind/core/services/invites'
import { publishChange } from '@mymind/core/utils/live-bus'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const id = getRouterParam(event, 'id')!
  await cancelInvite(id)
  publishChange({ resource: 'invite', action: 'deleted', id })
  return { ok: true }
})
```

```ts
// server/api/admin/users/invites/[id]/resend.post.ts
import { requireOwner } from '../../../../../utils/auth-guard'
import { findInviteById, rotateInviteToken, inviteLink } from '@mymind/core/services/invites'
import { sendInviteEmail } from '@mymind/core/lib/invites/email'
import { userDisplayName } from '@mymind/core/services/users'
import { publishChange } from '@mymind/core/utils/live-bus'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const id = getRouterParam(event, 'id')!
  const inv = await findInviteById(id)
  if (!inv) throw createError({ statusCode: 404, statusMessage: 'invite not found' })
  const link = inviteLink(await rotateInviteToken(id))
  const email = await sendInviteEmail({ to: inv.email, link, invitedByName: await userDisplayName((event.context.user as { id: string }).id) })
  publishChange({ resource: 'invite', action: 'updated', id })
  return { link, email }
})
```

Note `grantsSchema` is exported from the PATCH route module; Nitro treats a named export beside the default handler as fine. If the Nuxt build complains, move it to `server/utils/grants-schema.ts` and import from there in both routes.

- [ ] **Step 6: Run route tests + typecheck**

Run: `pnpm vitest run test/admin-users-routes.test.ts && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Composable + page**

```ts
// app/composables/useAdminUsers.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { ofetch } from 'ofetch'
import type { Grants } from '@mymind/core/shared/types/users'
import type { AdminUserDTO } from '@mymind/core/services/users'

export interface InviteDTO { id: string, email: string, grants: Grants, expiresAt: string, createdAt: string }

export function useAdminUsers() {
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['user', 'list'], queryFn: () => ofetch<{ users: AdminUserDTO[] }>('/api/admin/users') })
  const invites = useQuery({ queryKey: ['invite', 'list'], queryFn: () => ofetch<{ invites: InviteDTO[] }>('/api/admin/users/invites') })
  const inv = (k: string) => qc.invalidateQueries({ queryKey: [k, 'list'] })
  const update = useMutation({ mutationFn: (v: { id: string, grants?: Grants, banned?: boolean }) => ofetch(`/api/admin/users/${v.id}`, { method: 'PATCH', body: { grants: v.grants, banned: v.banned } }), onSuccess: () => inv('user') })
  const resetPassword = useMutation({ mutationFn: (id: string) => ofetch<{ password: string }>(`/api/admin/users/${id}/reset-password`, { method: 'POST' }) })
  const mint = useMutation({ mutationFn: (v: { email: string, grants: Grants }) => ofetch<{ link: string, email: 'sent' | 'no-resend' }>('/api/admin/users/invites', { method: 'POST', body: v }), onSuccess: () => inv('invite') })
  const cancel = useMutation({ mutationFn: (id: string) => ofetch(`/api/admin/users/invites/${id}`, { method: 'DELETE' }), onSuccess: () => inv('invite') })
  const resend = useMutation({ mutationFn: (id: string) => ofetch<{ link: string, email: 'sent' | 'no-resend' }>(`/api/admin/users/invites/${id}/resend`, { method: 'POST' }) })
  return { users, invites, update, resetPassword, mint, cancel, resend }
}
```

```vue
<!-- app/components/settings/UsersTab.vue -->
<script setup lang="ts">
import { FEATURES, DEFAULT_DAILY_QUOTA, type Feature, type Grants } from '@mymind/core/shared/types/users'
const { users, invites, update, resetPassword, mint, cancel, resend } = useAdminUsers()
const toast = useToast()
const rows = computed(() => users.data.value?.users ?? [])
const openInvites = computed(() => invites.data.value?.invites ?? [])
const draft = reactive<{ email: string, grants: Grants }>({ email: '', grants: { voice: true } })
const lastLink = ref<string | null>(null)
const tempPassword = ref<{ email: string, password: string } | null>(null)

function toggle(id: string, grants: Grants, f: Feature, on: boolean) {
  update.mutate({ id, grants: { ...grants, [f]: on } })
}
function setQuota(id: string, grants: Grants, v: number | string) {
  const n = Number(v); if (!Number.isFinite(n) || n <= 0) return
  update.mutate({ id, grants: { ...grants, dailyQuota: Math.floor(n) } })
}
async function sendInvite() {
  try {
    const r = await mint.mutateAsync({ email: draft.email.trim(), grants: draft.grants })
    lastLink.value = r.email === 'no-resend' ? r.link : null
    toast.add({ title: r.email === 'sent' ? `Invite emailed to ${draft.email}` : 'Resend not configured — copy the link below', color: r.email === 'sent' ? 'success' : 'warning' })
    draft.email = ''
  } catch (e) { toast.add({ title: 'Invite failed', description: (e as Error).message, color: 'error' }) }
}
async function doReset(u: { id: string, email: string }) {
  const r = await resetPassword.mutateAsync(u.id)
  tempPassword.value = { email: u.email, password: r.password }
}
async function doResend(id: string) {
  const r = await resend.mutateAsync(id)
  lastLink.value = r.email === 'no-resend' ? r.link : null
  toast.add({ title: r.email === 'sent' ? 'Invite re-sent' : 'Resend not configured — copy the link below', color: r.email === 'sent' ? 'success' : 'warning' })
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-base font-semibold text-highlighted">Users</h2>
        <p class="text-sm text-muted">Guests reach only the playground. Toggle what each one may use.</p>
      </div>
      <UAlert v-if="users.error.value" color="error" variant="subtle" title="Could not load users" />
      <UAlert v-if="tempPassword" color="warning" variant="subtle" :title="`Temporary password for ${tempPassword.email}`" :description="tempPassword.password" :close="true" @update:open="tempPassword = null" />
      <div class="flex flex-col divide-y divide-default border border-default rounded-lg">
        <div v-for="u in rows" :key="u.id" class="flex flex-wrap items-center gap-3 px-4 py-3" :data-user-email="u.email">
          <div class="min-w-48 flex-1">
            <div class="text-sm text-highlighted">{{ u.name }} <UBadge v-if="u.role === 'owner'" size="xs" color="primary" variant="subtle">owner</UBadge><UBadge v-else-if="u.bannedAt" size="xs" color="error" variant="subtle">revoked</UBadge></div>
            <div class="text-xs text-muted">{{ u.email }}<span v-if="u.googleLinked"> · Google</span><span v-if="u.lastSeenAt"> · seen {{ new Date(u.lastSeenAt).toLocaleDateString() }}</span></div>
          </div>
          <template v-if="u.role === 'guest'">
            <div class="flex items-center gap-3">
              <label v-for="f in FEATURES" :key="f" class="flex items-center gap-1 text-xs capitalize">
                <USwitch :model-value="u.grants[f] === true" :aria-label="`${f} for ${u.email}`" @update:model-value="(v: boolean) => toggle(u.id, u.grants, f, v)" /> {{ f }}
              </label>
            </div>
            <UInput :model-value="u.grants.dailyQuota ?? DEFAULT_DAILY_QUOTA" type="number" size="xs" class="w-20" :aria-label="`daily quota for ${u.email}`" @change="(e: Event) => setQuota(u.id, u.grants, (e.target as HTMLInputElement).value)" />
            <span class="text-xs text-muted">used today: {{ Object.entries(u.usage).map(([k, v]) => `${k} ${v.used}/${v.limit}`).join(' · ') || '—' }}</span>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-key-round" label="Reset password" @click="doReset(u)" />
            <UButton v-if="!u.bannedAt" size="xs" variant="ghost" color="error" icon="i-lucide-user-x" label="Revoke" @click="update.mutate({ id: u.id, banned: true })" />
            <UButton v-else size="xs" variant="ghost" color="success" icon="i-lucide-user-check" label="Restore" @click="update.mutate({ id: u.id, banned: false })" />
          </template>
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-base font-semibold text-highlighted">Invites</h2>
        <p class="text-sm text-muted">Single-use links, valid 7 days, emailed through Resend (Settings → Activity &amp; Alerts).</p>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Email"><UInput v-model="draft.email" type="email" placeholder="friend@example.com" aria-label="invite email" /></UFormField>
        <label v-for="f in FEATURES" :key="f" class="flex items-center gap-1 text-xs capitalize">
          <USwitch :model-value="draft.grants[f] === true" :aria-label="`invite ${f}`" @update:model-value="(v: boolean) => (draft.grants = { ...draft.grants, [f]: v })" /> {{ f }}
        </label>
        <UButton icon="i-lucide-send" label="Send invite" :loading="mint.isPending.value" :disabled="!draft.email" @click="sendInvite" />
      </div>
      <UAlert v-if="lastLink" color="warning" variant="subtle" title="Copy this link to the guest" :description="lastLink" />
      <div class="flex flex-col divide-y divide-default border border-default rounded-lg">
        <div v-if="!openInvites.length" class="px-4 py-3 text-sm text-muted">No open invites.</div>
        <div v-for="i in openInvites" :key="i.id" class="flex items-center gap-3 px-4 py-3">
          <div class="flex-1 text-sm text-highlighted">{{ i.email }} <span class="text-xs text-muted">· expires {{ new Date(i.expiresAt).toLocaleDateString() }}</span></div>
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-refresh-cw" label="Resend" @click="doResend(i.id)" />
          <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" aria-label="cancel invite" @click="cancel.mutate(i.id)" />
        </div>
      </div>
    </section>
  </div>
</template>
```

```vue
<!-- app/pages/settings/users.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Users' })
</script>
<template>
  <SettingsUsersTab />
</template>
```

In `app/layouts/default.vue` `settingsChildren`, after the API Keys entry add:

```ts
  { label: 'Users', icon: 'i-lucide-users', to: '/settings/users' },
```

- [ ] **Step 8: Browser check**

Start dev on a spare port (`PORT=3010 BETTER_AUTH_URL=http://localhost:3010 pnpm dev`, per the browser-testing skill), log in as the owner (the dev test account is now `owner` thanks to the backfill), open `/settings/users`, mint an invite to `guest1@example.com` with voice on. Two dev outcomes, both fine: if Settings → Activity & Alerts has no Resend key, the page shows the "copy this link" alert (use it); if it has one and `RESEND_FAKE=1` is set, nothing is sent and the dev terminal logs `[resend-fake] would send to=guest1@example.com …` — the link is then in the `text` body, so prefer the no-key path locally. Take a screenshot.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/services/users.ts packages/core/src/shared/types/live.ts app/utils/live-dispatch.ts server/api/admin/users app/composables/useAdminUsers.ts app/components/settings/UsersTab.vue app/pages/settings/users.vue app/layouts/default.vue test/admin-users-routes.test.ts
git commit -m "feat(admin): /settings/users — grants, quotas, revoke, reset password, invites"
```

---

### Task 8: Shared WAV render helper + guest voice API + `/api/me`

**Files:**
- Create: `server/lib/voice/render-wav.ts`, `server/api/play/voice/speak.post.ts`, `server/api/play/presets.get.ts`, `server/api/me.get.ts`
- Modify: `server/api/voice/speak.post.ts` (wav branch uses the helper), `packages/core/src/services/voice-presets.ts` (`listSharedPresets`, DTO `shared`)
- Test: `test/play-voice-speak-route.test.ts`, `test/me-route.test.ts`

**Interfaces:**
- `renderPresetWav(event, { text, preset, refAudio, mode }): Promise<Buffer>` — plans segments, sets the `x-segment-*` headers, collects PCM at `'studio'` priority, aborts delivery on close; throws `BreezeError` through (callers map with `toHttpError`, exported from the same file).
- `listSharedPresets(): Promise<Array<{ id, name, hasReference: boolean }>>`.
- `POST /api/play/voice/speak` `{ presetId, text }` → WAV; 403 (no grant / preset not shared), 429 quota `{ used, limit, resetsAt }`.
- `GET /api/me` → `MeDTO`.

- [ ] **Step 1: Write the failing route tests**

```ts
// test/play-voice-speak-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('setHeader', () => {})

const getPreset = vi.fn()
vi.mock('@mymind/core/services/voice-presets', () => ({ getPreset, loadReferenceBytes: async () => null }))
const consumeQuota = vi.fn()
vi.mock('@mymind/core/services/usage', () => ({ consumeQuota }))
const render = vi.fn(async () => Buffer.from('RIFF'))
vi.mock('../server/lib/voice/render-wav', () => ({ renderPresetWav: render, toHttpError: (e: Error) => e }))

const handler = (await import('../server/api/play/voice/speak.post')).default as (e: unknown) => Promise<unknown>
const evt = (client: unknown, grants: unknown, body: unknown) => ({ context: { client, user: { grants } }, body, node: { res: { on() {} } } })
const guest = { type: 'session', userId: 'g', role: 'guest' }
beforeEach(() => { getPreset.mockReset(); consumeQuota.mockReset(); render.mockClear(); consumeQuota.mockResolvedValue({ ok: true, used: 1 }) })

describe('POST /api/play/voice/speak', () => {
  it('403 without the voice grant', async () => {
    await expect(handler(evt(guest, {}, { presetId: 'p', text: 'hi' }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('403 on an unshared preset', async () => {
    getPreset.mockResolvedValue({ id: 'p', name: 'x', shared: false, maxSegmentChars: 200, instruction: null, refStorageKey: null })
    await expect(handler(evt(guest, { voice: true }, { presetId: 'p', text: 'hi' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(consumeQuota).not.toHaveBeenCalled()
  })
  it('429 with reset info when the quota is spent', async () => {
    getPreset.mockResolvedValue({ id: 'p', name: 'x', shared: true, maxSegmentChars: 200, instruction: null, refStorageKey: null })
    consumeQuota.mockResolvedValue({ ok: false, used: 2, limit: 2, resetsAt: '2026-10-22T05:00:00.000Z' })
    await expect(handler(evt(guest, { voice: true, dailyQuota: 2 }, { presetId: 'p', text: 'hi' }))).rejects.toMatchObject({ statusCode: 429, data: { used: 2, limit: 2 } })
    expect(render).not.toHaveBeenCalled()
  })
  it('renders a shared preset and ignores overrides/mode in the body', async () => {
    getPreset.mockResolvedValue({ id: 'p', name: 'x', shared: true, maxSegmentChars: 200, instruction: null, refStorageKey: null, seed: 1 })
    const out = await handler(evt(guest, { voice: true }, { presetId: 'p', text: 'hi', overrides: { seed: 999 }, mode: 'realtime' }))
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(consumeQuota).toHaveBeenCalledWith('g', 'voice', 20)
    const arg = render.mock.calls[0]![1] as { preset: { seed: number }, mode: string }
    expect(arg.preset.seed).toBe(1)
    expect(arg.mode).toBe('quality')
  })
  it('400 on empty text or text over the cap', async () => {
    getPreset.mockResolvedValue({ id: 'p', name: 'x', shared: true, maxSegmentChars: 200, instruction: null, refStorageKey: null })
    await expect(handler(evt(guest, { voice: true }, { presetId: 'p', text: '  ' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(handler(evt(guest, { voice: true }, { presetId: 'p', text: 'x'.repeat(2001) }))).rejects.toMatchObject({ statusCode: 400 })
  })
})
```

```ts
// test/me-route.test.ts
import { describe, it, expect, vi } from 'vitest'
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number }) => Object.assign(new Error('e'), o))
vi.mock('@mymind/core/services/usage', () => ({ usageFor: async () => ({ voice: { used: 1, limit: 20 } }) }))
const handler = (await import('../server/api/me.get')).default as (e: unknown) => Promise<unknown>
describe('GET /api/me', () => {
  it('returns role, grants and usage for a guest', async () => {
    const out = await handler({ context: { client: { type: 'session', userId: 'g', role: 'guest' }, user: { id: 'g', name: 'G', email: 'g@x.com', grants: { voice: true } } } })
    expect(out).toEqual({ id: 'g', name: 'G', email: 'g@x.com', role: 'guest', grants: { voice: true }, usage: { voice: { used: 1, limit: 20 } } })
  })
  it('403 for non-session clients', async () => {
    await expect(handler({ context: { client: { type: 'api-token' } } })).rejects.toMatchObject({ statusCode: 403 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/play-voice-speak-route.test.ts test/me-route.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Extract the render helper**

```ts
// server/lib/voice/render-wav.ts
// One WAV render path for the studio (owner, with overrides) and the playground (guest, none).
// Everything below the preset is identical: plan → validate → speak at 'studio' priority → WAV.
import type { H3Event } from 'h3'
import { speakSegments, collectPcm, pcmToWav, presetToRequest } from '@mymind/core/lib/voice/speak'
import { BreezeError, validateBreezeRequest } from '@mymind/core/lib/voice/breeze'
import { designPromptBudgetFor } from '@mymind/core/lib/voice/tts-provider'
import { VOICE_TUNING } from '@mymind/core/lib/voice/tuning'
import { coreConfig } from '@mymind/core/config'
import type { VoicePresetDTO } from '@mymind/core/shared/types/voice-presets'
import { planSegments, type SpeakMode } from './plan-segments'

export async function renderPresetWav(event: H3Event, input: { text: string, preset: VoicePresetDTO, refAudio: Uint8Array | null, mode: SpeakMode }): Promise<Buffer> {
  const invalid = validateBreezeRequest(presetToRequest(input.text, input.preset, input.refAudio))
  if (invalid) throw createError({ statusCode: 400, statusMessage: invalid })
  const cfg = coreConfig()
  const plan = planSegments(input.text, input.preset, input.mode, VOICE_TUNING.tts.sentenceMaxChars, {
    designBudget: designPromptBudgetFor(cfg.ttsProvider, cfg.ttsAudiocppMaxCallChars)
  })
  if (!plan.segments.length) throw createError({ statusCode: 400, statusMessage: 'text is required' })
  setHeader(event, 'x-segments', String(plan.segments.length))
  setHeader(event, 'x-segment-reason', plan.reason)
  setHeader(event, 'x-segment-ceiling', String(plan.ceiling))
  // A browser that goes away stops DELIVERY only — see speak.post.ts for why the rig call must finish.
  const ac = new AbortController()
  event.node.res.on('close', () => ac.abort())
  const { pcm, sampleRate } = await collectPcm(speakSegments(plan.segments, input.preset, 'studio', ac.signal, input.refAudio))
  setHeader(event, 'Content-Type', 'audio/wav')
  setHeader(event, 'Content-Disposition', `attachment; filename="${input.preset.name}.wav"`)
  return pcmToWav(pcm, sampleRate)
}

export function toHttpError(err: unknown) {
  if (err instanceof BreezeError) {
    const status = err.code === 'busy' ? 503 : err.code === 'preflight' ? 400 : 502
    return createError({ statusCode: status, statusMessage: err.message })
  }
  return createError({ statusCode: 500, statusMessage: (err as Error).message })
}
```

In `server/api/voice/speak.post.ts`, replace the `format === 'wav'` branch body with:

```ts
    if (body.format === 'wav') return await renderPresetWav(event, { text, preset, refAudio, mode })
```

and delete the now-duplicated validate/plan/header block **only if** the PCM-stream branch below it no longer needs `plan` — it does (it calls `speakSegments(plan.segments, …)`), so keep the plan computation for the stream branch and let `renderPresetWav` recompute for WAV (cheap, pure). Import `renderPresetWav, toHttpError` from `../../lib/voice/render-wav` and delete the local `toHttpError`.

Run: `pnpm vitest run server/api/voice/speak.test.ts` — Expected: PASS (existing studio test still green).

- [ ] **Step 4: Shared presets + the guest routes**

In `packages/core/src/services/voice-presets.ts`: add `shared: boolean` to `VoicePresetDTO` (`shared/types/voice-presets.ts`) and to `toDTO` (`shared: r.shared`), add `shared?: boolean` to `PresetInput`, and give `FALLBACK_PRESET` `shared: false`. Add:

```ts
export async function listSharedPresets(): Promise<Array<{ id: string, name: string, hasReference: boolean }>> {
  return (await listPresets()).filter(p => p.shared).map(p => ({ id: p.id, name: p.name, hasReference: p.refStorageKey !== null }))
}
```

```ts
// server/api/play/presets.get.ts
import { requireGrant } from '../../utils/auth-guard'
import { listSharedPresets } from '@mymind/core/services/voice-presets'
export default defineEventHandler(async (event) => { requireGrant(event, 'voice'); return { presets: await listSharedPresets() } })
```

```ts
// server/api/play/voice/speak.post.ts
// Guest render: shared preset only, no overrides, quality mode, counted against the day's quota.
import { requireGrant } from '../../../utils/auth-guard'
import { getPreset, loadReferenceBytes } from '@mymind/core/services/voice-presets'
import { consumeQuota } from '@mymind/core/services/usage'
import { quotaFor, type Grants } from '@mymind/core/shared/types/users'
import { renderPresetWav, toHttpError } from '../../../lib/voice/render-wav'

export const PLAY_TEXT_MAX = 2000

export default defineEventHandler(async (event) => {
  const userId = requireGrant(event, 'voice')
  const body = await readBody<{ presetId?: string, text?: string }>(event)
  const text = body?.text?.trim() ?? ''
  if (!text) throw createError({ statusCode: 400, statusMessage: 'text is required' })
  if (text.length > PLAY_TEXT_MAX) throw createError({ statusCode: 400, statusMessage: `text must be ${PLAY_TEXT_MAX} characters or fewer` })
  const preset = body?.presetId ? await getPreset(body.presetId) : null
  if (!preset || !preset.shared) throw createError({ statusCode: 403, statusMessage: 'preset not available' })
  const grants = (event.context.user as { grants?: Grants }).grants
  const q = await consumeQuota(userId, 'voice', quotaFor(grants))
  if (!q.ok) throw createError({ statusCode: 429, statusMessage: 'daily limit reached', data: { used: q.used, limit: q.limit, resetsAt: q.resetsAt } })
  try {
    return await renderPresetWav(event, { text, preset, refAudio: await loadReferenceBytes(preset), mode: 'quality' })
  } catch (err) { throw toHttpError(err) }
})
```

```ts
// server/api/me.get.ts
import { requireSession, type ClientContext } from '../utils/auth-guard'
import { usageFor } from '@mymind/core/services/usage'
import type { Grants, MeDTO } from '@mymind/core/shared/types/users'
export default defineEventHandler(async (event): Promise<MeDTO> => {
  requireSession(event)
  const client = event.context.client as ClientContext
  const u = event.context.user as { id: string, name: string, email: string, grants?: Grants }
  const grants = u.grants ?? {}
  return { id: u.id, name: u.name, email: u.email, role: client.role === 'owner' ? 'owner' : 'guest', grants, usage: client.role === 'owner' ? {} : await usageFor(u.id, grants) }
})
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run test/play-voice-speak-route.test.ts test/me-route.test.ts server/api/voice/speak.test.ts && pnpm typecheck`
Expected: PASS, clean. (The `me-route` test's owner branch `usage: {}` is implied; the guest case is asserted.)

- [ ] **Step 6: Commit**

```bash
git add server/lib/voice/render-wav.ts server/api/voice/speak.post.ts server/api/play server/api/me.get.ts packages/core/src/services/voice-presets.ts packages/core/src/shared/types/voice-presets.ts test/play-voice-speak-route.test.ts test/me-route.test.ts
git commit -m "feat(play): guest voice render over shared presets with daily quota; /api/me"
```

---

### Task 9: Studio "Share with guests" toggle

**Files:**
- Modify: `app/pages/settings/voice.vue`, `server/api/voice/presets/[id].patch.ts`
- Test: `test/voice-preset-patch-shared.test.ts`

**Interfaces:** `PATCH /api/voice/presets/:id { shared: boolean }` is owner-only (`requireOwner`) like the rest of the studio; already true via the middleware, made explicit here.

- [ ] **Step 1: Write the failing test**

```ts
// test/voice-preset-patch-shared.test.ts
import { describe, it, expect, vi } from 'vitest'
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number }) => Object.assign(new Error('e'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getRouterParam', () => 'p1')
const updatePreset = vi.fn(async (_id: string, patch: unknown) => ({ id: 'p1', ...(patch as object) }))
vi.mock('@mymind/core/services/voice-presets', () => ({ getPreset: async () => ({ id: 'p1' }), updatePreset, withoutCalibrationFields: (b: unknown) => b, ensureCalibrated: async (p: unknown) => ({ preset: p, calibrationWarning: null }) }))
const handler = (await import('../server/api/voice/presets/[id].patch')).default as (e: unknown) => Promise<unknown>
describe('PATCH /api/voice/presets/:id shared', () => {
  it('forwards shared:true for an owner session', async () => {
    await handler({ context: { client: { type: 'session', role: 'owner', userId: 'o' } }, body: { shared: true } })
    expect(updatePreset).toHaveBeenCalledWith('p1', { shared: true })
  })
  it('403s a guest session even though the middleware would already block it', async () => {
    await expect(handler({ context: { client: { type: 'session', role: 'guest', userId: 'g' } }, body: { shared: true } })).rejects.toMatchObject({ statusCode: 403 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/voice-preset-patch-shared.test.ts`
Expected: FAIL on the 403 case.

- [ ] **Step 3: Guard the route and add the toggle**

In `server/api/voice/presets/[id].patch.ts` add `import { requireOwner } from '../../../utils/auth-guard'` and `requireOwner(event)` as the first statement.

In `app/pages/settings/voice.vue`, next to the existing make-default action (the `$fetch(`/api/voice/presets/${id}`, { method: 'PATCH', body: { isDefault: true } })` call around line 144), add:

```ts
async function setShared(id: string, shared: boolean) {
  await $fetch(`/api/voice/presets/${id}`, { method: 'PATCH', body: { shared } })
  await refreshPresets()   // whatever the page already calls after make-default; reuse that exact function name
}
```

and in the template, in the header area of the design panel where the selected preset's name/default badge shows, add:

```vue
<label v-if="selected" class="flex items-center gap-2 text-xs text-muted">
  <USwitch :model-value="selected.shared" aria-label="Share with guests" @update:model-value="(v: boolean) => setShared(selected!.id, v)" />
  Share with guests
</label>
```

- [ ] **Step 4: Run tests, typecheck, browser-validate**

Run: `pnpm vitest run test/voice-preset-patch-shared.test.ts && pnpm typecheck`
Then in the dev browser (`playwright-cli`), open `/settings/voice`, real-`click` the switch (reka-ui), reload and confirm it stays on; `GET /api/play/presets` as the owner returns that preset.

- [ ] **Step 5: Commit**

```bash
git add server/api/voice/presets/[id].patch.ts app/pages/settings/voice.vue test/voice-preset-patch-shared.test.ts
git commit -m "feat(voice): share a preset with guests from the studio"
```

---

### Task 10: Guest surface — layout, `/play`, `/play/voice`, `/play/account`, client guards

**Files:**
- Create: `app/layouts/playground.vue`, `app/pages/play/index.vue`, `app/pages/play/voice.vue`, `app/pages/play/account.vue`, `app/composables/useMe.ts`
- Modify: `app/lib/auth-client.ts`, `app/middleware/auth.global.ts`, `app/plugins/live.client.ts`, `app/plugins/presence.client.ts`
- Test: `test/auth-redirect-guest.test.ts` (pure helper), browser run

**Interfaces:**
- `useMe()` → `useQuery(['me'])` of `MeDTO`.
- `guestRedirect(path: string, role: Role | undefined): string | null` (pure, in `app/lib/guest-redirect.ts`): guests outside `/play` → `'/play'`; else `null`.
- `authClient` gains `inferAdditionalFields` (types) and `genericOAuthClient` (used by Task 11; harmless now).

- [ ] **Step 1: Write the failing pure test**

```ts
// test/auth-redirect-guest.test.ts
import { describe, it, expect } from 'vitest'
import { guestRedirect } from '../app/lib/guest-redirect'
describe('guestRedirect', () => {
  it('sends guests anywhere outside /play to /play', () => {
    expect(guestRedirect('/documents', 'guest')).toBe('/play')
    expect(guestRedirect('/', 'guest')).toBe('/play')
    expect(guestRedirect('/settings/users', 'guest')).toBe('/play')
  })
  it('lets guests stay under /play and owners go anywhere', () => {
    expect(guestRedirect('/play', 'guest')).toBeNull()
    expect(guestRedirect('/play/voice', 'guest')).toBeNull()
    expect(guestRedirect('/documents', 'owner')).toBeNull()
    expect(guestRedirect('/play', 'owner')).toBeNull()
  })
  it('treats an unknown role as guest', () => {
    expect(guestRedirect('/documents', undefined)).toBe('/play')
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm vitest run test/auth-redirect-guest.test.ts` → FAIL (module missing).

```ts
// app/lib/guest-redirect.ts
import type { Role } from '@mymind/core/shared/types/users'
export function guestRedirect(path: string, role: Role | undefined): string | null {
  if (role === 'owner') return null
  return path === '/play' || path.startsWith('/play/') ? null : '/play'
}
```

`app/lib/auth-client.ts`:

```ts
import { createAuthClient } from 'better-auth/vue'
import { inferAdditionalFields, genericOAuthClient } from 'better-auth/client/plugins'
export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields({ user: { role: { type: 'string' }, grants: { type: 'json' }, bannedAt: { type: 'date' } } }),
    genericOAuthClient()
  ]
})
```

`app/middleware/auth.global.ts` — after the session check succeeds:

```ts
import { guestRedirect } from '~/lib/guest-redirect'
// …inside the handler, after `if (!data?.session) { … }`:
  const target = guestRedirect(to.path, (data.user as { role?: 'owner' | 'guest' }).role)
  if (target && to.path !== target) return navigateTo(target)
```

`app/plugins/live.client.ts` and `app/plugins/presence.client.ts` — in each `syncToSession`, treat a guest as signed out:

```ts
const { data } = await authClient.getSession()
const isOwner = (data?.user as { role?: string } | undefined)?.role === 'owner'
if (data?.session && isOwner) openStream() else disconnect()      // live.client.ts
signedIn = !!data?.session && isOwner                                // presence.client.ts
```

Run: `pnpm vitest run test/auth-redirect-guest.test.ts` → PASS.

- [ ] **Step 3: `useMe` and the layout**

```ts
// app/composables/useMe.ts
import { useQuery } from '@tanstack/vue-query'
import { ofetch } from 'ofetch'
import type { MeDTO } from '@mymind/core/shared/types/users'
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => ofetch<MeDTO>('/api/me') })
}
```

```vue
<!-- app/layouts/playground.vue -->
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { FEATURES } from '@mymind/core/shared/types/users'
const { data: me } = useMe()
const route = useRoute()
const tabs = computed(() => FEATURES.filter(f => me.value?.grants[f] === true).map(f => ({ label: f[0]!.toUpperCase() + f.slice(1), to: `/play/${f}`, disabled: f !== 'voice' })))
async function signOut() { await authClient.signOut(); await navigateTo('/login') }
</script>

<template>
  <div class="min-h-screen bg-default text-default">
    <header class="border-b border-default">
      <div class="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3">
        <NuxtLink to="/play" class="font-semibold text-highlighted">Bridget</NuxtLink>
        <nav class="flex items-center gap-1">
          <UButton v-for="t in tabs" :key="t.to" :to="t.disabled ? undefined : t.to" :label="t.label" :disabled="t.disabled" size="sm" variant="ghost" :color="route.path.startsWith(t.to) ? 'primary' : 'neutral'" />
        </nav>
        <div class="ml-auto flex items-center gap-2">
          <UButton to="/play/account" size="sm" variant="ghost" color="neutral" icon="i-lucide-user-round" :label="me?.name ?? 'Account'" />
          <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-log-out" aria-label="Sign out" @click="signOut" />
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-4xl px-4 py-6">
      <slot />
    </main>
  </div>
</template>
```

- [ ] **Step 4: Pages**

```vue
<!-- app/pages/play/index.vue -->
<script setup lang="ts">
import { FEATURES } from '@mymind/core/shared/types/users'
definePageMeta({ layout: 'playground' })
const { data: me } = useMe()
const cards = computed(() => FEATURES.filter(f => me.value?.grants[f] === true))
const blurb: Record<string, string> = { voice: "Speak any text in one of Tony's voices.", music: 'Coming soon.', image: 'Coming soon.', video: 'Coming soon.' }
</script>
<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Hi {{ me?.name }}</h1>
      <p class="text-sm text-muted">Here's what you can play with.</p>
    </div>
    <p v-if="me && !cards.length" class="text-sm text-muted">Nothing has been switched on for you yet — ask Tony.</p>
    <div class="grid gap-4 sm:grid-cols-2">
      <UCard v-for="f in cards" :key="f">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="font-medium capitalize text-highlighted">{{ f }}</div>
            <div class="text-sm text-muted">{{ blurb[f] }}</div>
            <div v-if="me?.usage[f]" class="mt-1 text-xs text-muted">{{ me.usage[f]!.used }}/{{ me.usage[f]!.limit }} used today</div>
          </div>
          <UButton :to="`/play/${f}`" :disabled="f !== 'voice'" label="Open" />
        </div>
      </UCard>
    </div>
  </div>
</template>
```

```vue
<!-- app/pages/play/voice.vue -->
<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ofetch } from 'ofetch'
definePageMeta({ layout: 'playground' })
const qc = useQueryClient()
const { data: me } = useMe()
const { data: presetsData } = useQuery({ queryKey: ['play-presets'], queryFn: () => ofetch<{ presets: Array<{ id: string, name: string, hasReference: boolean }> }>('/api/play/presets') })
const presets = computed(() => presetsData.value?.presets ?? [])
const presetId = ref<string | null>(null)
watch(presets, p => { if (!presetId.value && p[0]) presetId.value = p[0].id }, { immediate: true })
const text = ref('')
const MAX = 2000
const busy = ref(false)
const error = ref<string | null>(null)
const audioUrl = ref<string | null>(null)
const quota = computed(() => me.value?.usage.voice)
const exhausted = computed(() => !!quota.value && quota.value.used >= quota.value.limit)

async function speak() {
  if (!presetId.value || !text.value.trim()) return
  busy.value = true; error.value = null
  try {
    const wav = await $fetch<Blob>('/api/play/voice/speak', { method: 'POST', body: { presetId: presetId.value, text: text.value }, responseType: 'blob' })
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = URL.createObjectURL(wav)
    await qc.invalidateQueries({ queryKey: ['me'] })
  } catch (e) {
    const err = e as { statusCode?: number, data?: { resetsAt?: string }, statusMessage?: string }
    error.value = err.statusCode === 429
      ? `Daily limit reached — resets ${err.data?.resetsAt ? new Date(err.data.resetsAt).toLocaleString() : 'tomorrow'}.`
      : err.statusCode === 503 ? 'The voice engine is busy — try again in a moment.'
      : (err.statusMessage ?? 'Something went wrong')
    await qc.invalidateQueries({ queryKey: ['me'] })
  } finally { busy.value = false }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Voice</h1>
        <p class="text-sm text-muted">Pick a voice, type something, press Speak.</p>
      </div>
      <div v-if="quota" class="text-xs text-muted" data-testid="voice-quota">{{ quota.used }}/{{ quota.limit }} today</div>
    </div>
    <UFormField label="Voice">
      <USelect v-model="presetId" :items="presets.map(p => ({ label: p.name, value: p.id }))" placeholder="No voices shared yet" :disabled="!presets.length" class="w-64" />
    </UFormField>
    <UFormField label="Text" :hint="`${text.length}/${MAX}`">
      <UTextarea v-model="text" :maxlength="MAX" :rows="5" autoresize placeholder="What should it say?" class="w-full" />
    </UFormField>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div class="flex items-center gap-3">
      <UButton icon="i-lucide-audio-lines" label="Speak" :loading="busy" :disabled="!presetId || !text.trim() || exhausted" @click="speak" />
      <UButton v-if="audioUrl" :href="audioUrl" download="bridget-voice.wav" variant="outline" color="neutral" icon="i-lucide-download" label="Download WAV" />
    </div>
    <audio v-if="audioUrl" :src="audioUrl" controls autoplay class="w-full" data-testid="voice-player" />
  </div>
</template>
```

```vue
<!-- app/pages/play/account.vue -->
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
definePageMeta({ layout: 'playground' })
const { data: me } = useMe()
const pw = reactive({ current: '', next: '' })
const msg = ref<string | null>(null)
const googleEnabled = useRuntimeConfig().public.googleLogin === true
async function changePassword() {
  const r = await authClient.changePassword({ currentPassword: pw.current, newPassword: pw.next, revokeOtherSessions: true })
  msg.value = r.error ? (r.error.message ?? 'Could not change password') : 'Password changed.'
  pw.current = ''; pw.next = ''
}
function linkGoogle() { authClient.oauth2.link({ providerId: 'google-login', callbackURL: '/play/account' }) }
</script>

<template>
  <div class="flex max-w-md flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Account</h1>
      <p class="text-sm text-muted">{{ me?.name }} · {{ me?.email }}</p>
    </div>
    <UCard>
      <template #header><div class="font-medium text-highlighted">Change password</div></template>
      <div class="flex flex-col gap-3">
        <UFormField label="Current password"><UInput v-model="pw.current" type="password" class="w-full" /></UFormField>
        <UFormField label="New password"><UInput v-model="pw.next" type="password" class="w-full" /></UFormField>
        <UAlert v-if="msg" variant="subtle" :title="msg" />
        <UButton label="Update" :disabled="!pw.current || pw.next.length < 8" @click="changePassword" />
      </div>
    </UCard>
    <UCard v-if="googleEnabled">
      <template #header><div class="font-medium text-highlighted">Google</div></template>
      <UButton variant="outline" color="neutral" icon="i-simple-icons-google" label="Link Google sign-in" @click="linkGoogle" />
    </UCard>
  </div>
</template>
```

`runtimeConfig.public.googleLogin` is added in Task 11; until then add `googleLogin: false` to `nuxt.config.ts` `runtimeConfig.public` in THIS task so the pages typecheck (Task 11 replaces the value with the env-derived one).

- [ ] **Step 5: Typecheck + browser-validate the guest flow**

Run: `pnpm typecheck` → clean.
With dev running on :3010 and `RESEND_FAKE=1`: as owner, mint an invite for `guest1@example.com` (voice on); read the link from the dev log; in a fresh `playwright-cli` session open it, fill name + password (`guestpass123`), click **Create account**; expect to land on `/play` with one *Voice* card; open `/play/voice`, select the shared preset from Task 9, type "Hello from the playground", click **Speak**, assert `audio[data-testid=voice-player]` appears and `[data-testid=voice-quota]` reads `1/20 today`; `goto /documents` → URL is `/play`; `playwright-cli eval "fetch('/api/documents').then(r=>r.status)"` → 403. Screenshot `/play/voice`.

- [ ] **Step 6: Commit**

```bash
git add app/layouts/playground.vue app/pages/play app/composables/useMe.ts app/lib/auth-client.ts app/lib/guest-redirect.ts app/middleware/auth.global.ts app/plugins/live.client.ts app/plugins/presence.client.ts nuxt.config.ts test/auth-redirect-guest.test.ts
git commit -m "feat(play): playground layout, hub, voice page, account page; guests routed to /play"
```

---

### Task 11: Google sign-in for guests (`google-login`)

**Files:**
- Create: `packages/core/src/lib/auth/google-login.ts`
- Modify: `packages/core/src/lib/auth/index.ts`, `packages/core/src/lib/google/auth-options.ts`, `nuxt.config.ts`, `app/pages/invite/[token].vue`, `app/pages/login.vue`
- Test: `test/auth-google-login-wiring.test.ts`, extend `test/auth-google-wiring.test.ts`

**Interfaces:**
- `googleLoginProvider(clientId, clientSecret)` → one `GenericOAuthConfig` with `providerId: 'google-login'`, `discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration'`, `scopes: ['openid','email','profile']`, `pkce: true`, `disableImplicitSignUp: false` (sign-up is gated by the Task 2 hook, which refuses uninvited emails), `mapProfileToUser: p => ({ name: p.name ?? p.email, email: p.email, image: p.picture })`.
- `runtimeConfig.public.googleLogin = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)`.

- [ ] **Step 1: Write the failing wiring test**

```ts
// test/auth-google-login-wiring.test.ts
import { describe, it, expect } from 'vitest'
import { googleLoginProvider } from '@mymind/core/lib/auth/google-login'
describe('google-login provider', () => {
  it('is a login-only OIDC provider with minimal scopes and PKCE', () => {
    const p = googleLoginProvider('id', 'secret')
    expect(p).toMatchObject({ providerId: 'google-login', clientId: 'id', clientSecret: 'secret', scopes: ['openid', 'email', 'profile'], pkce: true, disableImplicitSignUp: false })
    expect(p.discoveryUrl).toBe('https://accounts.google.com/.well-known/openid-configuration')
  })
  it('maps the Google profile to name/email/image only', () => {
    const p = googleLoginProvider('id', 'secret')
    expect(p.mapProfileToUser!({ sub: '1', email: 'a@x.com', name: 'A', picture: 'http://p', hd: 'x.com' })).toEqual({ name: 'A', email: 'a@x.com', image: 'http://p' })
  })
})
```

Append to `test/auth-google-wiring.test.ts` (the file builds `auth` with empty Google creds, and a second with creds if it already does — follow its pattern):

```ts
  it('cycle 89: google-login is registered through generic-oauth only when Google is configured', () => {
    const withGoogle = buildAuth({ ...cfg, googleClientId: 'id', googleClientSecret: 'sec' } as never)
    const plugin = withGoogle.options.plugins?.find(p => p.id === 'generic-oauth')
    expect(plugin).toBeDefined()
    const without = buildAuth({ ...cfg } as never)
    expect(without.options.plugins?.find(p => p.id === 'generic-oauth')).toBeUndefined()
  })
  it('cycle 89: the connection hook still ignores google-login accounts', async () => {
    // syncConnection filters providerId === 'google'; a google-login row must not create a connection.
    const { account } = withGoogle.options.databaseHooks!
    // exercised in Task 2's hook tests at the unit level; here we assert the filter constant is unchanged
    expect(String(account!.create!.after)).toContain("syncConnection")
  })
```

(If the second assertion is awkward, replace it with a unit test on `syncConnection` by exporting it from `lib/auth/index.ts` and asserting `upsertConnectionForAccount` is not called for `providerId: 'google-login'` — do that instead if `String(fn)` proves brittle.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/auth-google-login-wiring.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/lib/auth/google-login.ts
// Cycle 89: a SECOND Google provider, for signing in only. The cycle-79 'google' provider is the
// Gmail/Calendar CONNECTION (its account rows become Bridget connections); this one asks for
// openid/email/profile and its rows are ignored by syncConnection. Sign-up through it is gated
// by beforeUserCreate (hooks.ts): no open invite for the Google email → no user.
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth'

export const GOOGLE_LOGIN_PROVIDER_ID = 'google-login'

export function googleLoginProvider(clientId: string, clientSecret: string): GenericOAuthConfig {
  return {
    providerId: GOOGLE_LOGIN_PROVIDER_ID,
    discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    clientId, clientSecret,
    scopes: ['openid', 'email', 'profile'],
    pkce: true,
    disableImplicitSignUp: false,
    mapProfileToUser: (p: Record<string, unknown>) => ({ name: String(p.name ?? p.email ?? ''), email: String(p.email ?? ''), image: typeof p.picture === 'string' ? p.picture : undefined })
  }
}
```

(If the `GenericOAuthConfig` type is not exported from `better-auth/plugins/generic-oauth`, import it from `better-auth/plugins` as `import type { GenericOAuthConfig } from 'better-auth/plugins'`.)

In `packages/core/src/lib/auth/index.ts`: import `genericOAuth` from `'better-auth/plugins'` and `googleLoginProvider` and build the plugin list:

```ts
    plugins: [
      mcp({ /* unchanged */ }),
      ...(cfg.googleClientId && cfg.googleClientSecret
        ? [genericOAuth({ config: [googleLoginProvider(cfg.googleClientId as string, cfg.googleClientSecret as string)] })]
        : [])
    ]
```

In `packages/core/src/lib/google/auth-options.ts`, the `GOOGLE_AUTH_HOOKS.before` refusal of `/sign-in/social` stays exactly as is (it protects the `google` connection provider). Add a comment line noting `/sign-in/oauth2` (`google-login`) is the guest login path and is gated by `lib/auth/hooks.ts`.

`nuxt.config.ts` → `runtimeConfig.public.googleLogin: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)` (replace the Task 10 placeholder).

Google Cloud console: add `https://<BETTER_AUTH_URL>/api/auth/oauth2/callback/google-login` (and the `localhost:3010` twin) to the OAuth client's authorized redirect URIs — note this in the handover; without it the button errors at Google.

- [ ] **Step 4: Restore the Google button on the invite page**

In `app/pages/invite/[token].vue` add back (from Task 6's listing) the `google()` function and the `<UButton v-if="googleEnabled" … label="Continue with Google" @click="google" />`. In `app/pages/login.vue`, below the form, add the same button (`googleEnabled = useRuntimeConfig().public.googleLogin === true`; `authClient.signIn.oauth2({ providerId: 'google-login', callbackURL: '/play', errorCallbackURL: '/login?error=google' })`) with an error alert when `route.query.error === 'google'` reading "Google sign-in is for invited guests; the Google email must match an open invite." Owners keep using email/password.

- [ ] **Step 5: Run tests + typecheck + browser-validate**

Run: `pnpm vitest run test/auth-google-login-wiring.test.ts test/auth-google-wiring.test.ts test/auth-user-hooks.test.ts && pnpm typecheck`
Browser (only if dev `.env` has Google creds and the redirect URI is registered): mint an invite for your own secondary Google email, open the link, click **Continue with Google**, finish consent, expect `/play`; `/settings/connections` as owner shows **no** new connection. If creds are absent locally, record that this path is validated in prod acceptance in the handover.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lib/auth/google-login.ts packages/core/src/lib/auth/index.ts packages/core/src/lib/google/auth-options.ts nuxt.config.ts app/pages/invite app/pages/login.vue test/auth-google-login-wiring.test.ts test/auth-google-wiring.test.ts
git commit -m "feat(auth): google-login provider for invited guests (generic-oauth, login-only scopes)"
```

---

### Task 12: End-to-end browser test, docs, handover

**Files:**
- Create: `docs/wiki/playground.md`, `docs/handovers/2026-10-21-cycle-89-guest-accounts.md`, `.claude/skills/browser-testing/guest-flow.md` (the scripted run below, so it is repeatable)
- Modify: `docs/wiki/auth.md`, `docs/wiki/voice-studio.md`, `docs/wiki/README.md`, `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`, `.env.example` (comment: `ALLOW_SIGNUP` bootstraps the first owner only; guests via invites)

- [ ] **Step 1: Full gates**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all green. Then `pnpm test:db` for the quota race test.

- [ ] **Step 2: Scripted browser run (playwright-cli, dev on :3010, `RESEND_FAKE=1`)**

1. Owner login (`test@example.com` / `testpassword123`); `/settings/users` shows the owner row with an `owner` badge and no toggles.
2. Mint invite `guest1@example.com`, voice on, quota 2 (set after accept via the quota input). Read the link from the dev log (`[resend-fake] …` or the on-page link alert).
3. New context: open the link → name `Guest One`, password `guestpass123` → lands on `/play`.
4. `/play/voice`: speak twice (quota shows `2/2`), third Speak is disabled / returns the limit alert.
5. `goto /documents` → `/play`. `eval fetch('/api/memories')` → 403. `eval fetch('/api/events')` → 403.
6. Owner: Revoke guest → guest's next `goto /play` lands on `/login`. Restore → works again.
7. Screenshots: `/settings/users`, `/play/voice` with player.

Save the exact command sequence into `.claude/skills/browser-testing/guest-flow.md`.

- [ ] **Step 3: Wiki + roadmap + backlog**

- `docs/wiki/playground.md` (new, `status: shipped`, `cycle: 89`): what guests are, the allow-list, invites, grants/quotas, `/play/**` pages, `/api/play/**` + `/api/me`, the `google-login` provider and why it is separate, what guests never get.
- `docs/wiki/auth.md`: bump `updated`, add sections *Roles* (`user.role`, `grants`, `banned_at`), *Guest allow-list* (`GUEST_PREFIXES`, owner-only OAuth tokens), *Invites*, *google-login vs google*. Rewrite *Sign-up gate* to "first owner only".
- `docs/wiki/voice-studio.md`: add the `shared` flag + "Share with guests" toggle; bump `updated`.
- `docs/wiki/README.md`: add `| Playground (guest accounts) | [playground.md](playground.md) | shipped |`.
- `docs/superpowers/plans/00-roadmap.md`: add row 89 (shipped) and a planned row 90 (media studio).
- `docs/BACKLOG.md`: add "Multi-tenant Bridget (signal-gated)" pointer to the MyMind task, and cycle-90 items.
- Mirror changed wiki pages to MyMind with the **wiki-mirror** skill.

- [ ] **Step 4: Handover**

`docs/handovers/2026-10-21-cycle-89-guest-accounts.md` with frontmatter `title, cycle: 89, status: built, date: 2026-10-21, branch, merged: false, deployed: false, specs, wiki, migrations: [0092_guest_accounts], shipped: [...], deferred: [...], next_seam`. Body: what shipped per task, the Google redirect-URI prod step, the owner backfill note (every existing user became owner), acceptance checklist (the browser run), deferred items (music/image/video, generations + worker queue, self-service password reset, guest SSE), and `next_seam: cycle 90 media studio — add 'music' to the grants the hub already renders; /api/play/music/* beside /api/play/voice/*; generations table with user_id`.

- [ ] **Step 5: Commit, then update the MyMind task**

```bash
git add docs .claude/skills/browser-testing/guest-flow.md .env.example
git commit -m "docs: cycle 89 wiki (playground, auth, voice studio), roadmap, handover"
```

Edit the MyMind task *Cycle 89 — Guest accounts…* checklist/status to reflect built + awaiting acceptance.

---

## Self-review notes

- **Spec coverage:** §1 schema → T1; §2 middleware/guards/client guard/google-login → T3, T10, T11; §3 invites + admin page → T5, T6, T7; §4 guest surface + APIs → T8, T10; §5 errors → T6 (status map), T8 (429 payload, sanitized rig errors via `toHttpError`), T10 (429 → reset time; 403 → `/play` by the route guard rather than a `$fetch` interceptor, which this app does not have — the spec's "client `$fetch` error hook" is satisfied by the guard plus per-page error alerts); §6 tests → every task + T12 browser run; §7 → handover.
- **Interfaces check:** `requireGrant` returns `userId` (T3) and T8 uses it; `consumeQuota(userId, kind, limit)` (T4) matches T8's call; `createInvite` returns `{ invite, token }` (T5) matches T7; `AdminUserDTO` shape (T7) matches the composable; `MeDTO` (T1) matches `/api/me` (T8) and `useMe` (T10); `GOOGLE_LOGIN_CALLBACK = '/oauth2/callback/google-login'` (T2) matches generic-oauth's registered path (`/oauth2/callback/:providerId`).
- **Known risk to verify during T2/T5:** `internalAdapter.createUser` running `databaseHooks` with a `ctx` whose `path` is `undefined` (direct call) — `beforeUserCreate` treats that as a credential path → `guest`, which is what the accept route wants. If better-auth 1.6.13's internalAdapter does not run hooks on direct calls, T5's `acceptInviteWithPassword` already sets `role: 'guest'` and `grants` explicitly afterwards, so the outcome is the same.
