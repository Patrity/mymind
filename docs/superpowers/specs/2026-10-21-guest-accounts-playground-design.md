---
title: "Cycle 89: guest accounts, invites, feature grants, and the voice playground"
cycle: 89
date: 2026-10-21
status: proposed
---

# Cycle 89: guest accounts + playground (voice)

**Decision (2026-10-21).** MyMind stays single-tenant. Tony is the one **owner**; other people get **guest**
accounts that reach a small, allow-listed **playground** (`/play/**`) and nothing else: no documents, memories,
tasks, Bridget, connections or settings. Full multitenancy (schema-per-tenant, "option B") is a signal-gated
backlog item (MyMind task *Multi-tenant Bridget*), to be started only if guests keep asking for their own Bridget.

This cycle builds the permission model and proves it end to end with one playground feature, **voice** (speak with
Tony's shared presets). Cycle 90 adds the media studio (music via MiniMax Music 3 on audio.cpp, image via ComfyUI,
video when a model exists) behind the same grants.

## Goals

1. Tony can invite a person by email, choose what they may use, and revoke them later, all from one admin page.
2. A guest can accept the invite with a password or Google, land on `/play`, and use the voice playground.
3. A guest can reach **nothing** of Tony's: the server denies by default, not per route.
4. The rig is protected: every guest render counts against a per-day quota and yields to Tony's live turns.

## Non-goals (cycle 90+)

Music/image/video pages, the `generations` table and worker queue, email verification and self-service password
reset (Tony resets from the admin page), guest-visible live updates (SSE), API tokens or MCP for guests, any
per-tenant data scoping.

## 1. Schema (migration 0092)

### `user` (better-auth table, `packages/core/src/db/schema/auth.ts`)

| column | type | notes |
|---|---|---|
| `role` | `text not null default 'guest'` | `'owner' \| 'guest'`. CHECK constraint. |
| `grants` | `jsonb not null default '{}'` | `Grants` below. |
| `banned_at` | `timestamptz` | revoked guests; sessions are also deleted on revoke. |

```ts
// packages/core/src/shared/types/users.ts
export type Feature = 'voice' | 'music' | 'image' | 'video'
export interface Grants { voice?: boolean; music?: boolean; image?: boolean; video?: boolean; dailyQuota?: number }
export const DEFAULT_DAILY_QUOTA = 20   // renders per feature per day when dailyQuota is unset
```

Both fields are declared to better-auth through `user.additionalFields` with `input: false` so no sign-up body can
set them. **Backfill:** every user existing at migration time becomes `role='owner'`.

**First-owner rule.** A `databaseHooks.user.create.before` hook sets `role='owner'` when the `user` table is empty
and `'guest'` otherwise. `ALLOW_SIGNUP` keeps its one job: bootstrapping that first account. Guests never use it.

### `invites` (new, `schema/invites.ts`)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `email` | text not null | lower-cased; one *open* invite per email (partial unique index where `used_at is null`) |
| `token_hash` | text not null unique | sha256 of a 32-byte random token; the plaintext appears only in the email |
| `grants` | jsonb not null | snapshot applied on accept |
| `invited_by` | text not null → `user.id` | |
| `expires_at` | timestamptz not null | 7 days |
| `used_at`, `used_by` | timestamptz, text → `user.id` | |
| `created_at` | timestamptz not null default now() | |

### `usage_counters` (new, `schema/usage-counters.ts`)

`(user_id, day, kind)` primary key, `count int not null default 0`. `day` is a `date` in the app timezone
(`getDefaultTimezone()`, `lib/google/time.ts`; prod runs UTC, so never `new Date().toISOString().slice(0,10)`).
`kind` is a `Feature`. Cycle 90's `generations` rows reference the same `kind` values.

### `voice_presets.shared boolean not null default false`

Guests list and speak only presets with `shared = true`. The studio gets a "Share with guests" toggle on the preset
row. The reference clip and `ref_text` never leave the server on any guest path (they are sent to the rig only).

## 2. Auth and authorization

### Server (`server/middleware/auth.ts`)

After a **session** resolves, one new branch:

```ts
const GUEST_PREFIXES = ['/api/auth', '/api/play', '/api/me']
if (session.user.role !== 'owner' && !GUEST_PREFIXES.some(p => url === p || url.startsWith(p + '/')))
  throw createError({ statusCode: 403, statusMessage: 'Forbidden: owner only' })
```

Properties:
- **Deny by default.** The 228 existing routes need no edit; a route nobody thought about 403s a guest.
- A banned user (`banned_at` set) is refused at this point as well (sessions are deleted on revoke; this closes the
  race for an in-flight request).
- `mm_` API tokens and MCP OAuth tokens are **owner-only**: a guest cannot reach `/api/settings/tokens` to mint one,
  and the MCP consent page refuses non-owner sessions (`requireOwner`). Existing owner tokens are unaffected.
- `server/utils/auth-guard.ts` gains `requireOwner(event)` (session + `role === 'owner'`) for defence in depth on
  `/api/admin/users/**` and the preset `shared` toggle, and `requireGrant(event, feature)` for `/api/play/**`.

### Client (`app/middleware/auth.global.ts`)

`/invite/**` joins the public routes. After the session check, a guest navigating outside `/play/**` is redirected
to `/play`. Owners may visit `/play` (useful for checking what guests see). Role comes from the session's user
object (better-auth includes additional fields in `getSession`).

### Google sign-in for guests (`google-login`)

Cycle 79 closed Google sign-in on purpose: the `google` provider carries Gmail/Calendar scopes and every
`account(providerId='google')` row is synced into Bridget's unscoped `connections` table. A guest must never enter
through that provider. So:

- Add better-auth's `generic-oauth` plugin with **providerId `google-login`**, same client id/secret, scopes
  `openid email profile` only, `disableImplicitSignUp: true`.
- `syncConnection` already filters on `providerId === 'google'`; `google-login` rows never become connections.
  A test pins this.
- The cycle-79 `before` hook that refuses `/sign-in/social` stays. `google-login` goes through
  `/sign-in/oauth2` (generic-oauth's path), which gets its own `before` hook: allowed only when the user already
  has a `google-login` account **or** an open invite matches the Google email (case-insensitive). Otherwise
  `FORBIDDEN`. Accepting through Google consumes the invite in the `account.create.after` hook.
- Linking: a guest who accepted with a password can later add Google from `/play/account` via
  `linkSocial({ providerId: 'google-login' })`; `allowDifferentEmails` stays as is.

## 3. Invites

**Mint.** `POST /api/admin/users/invites` (`requireOwner`): `{ email, grants }` → create row, email the link with
`sendResendEmail` (`lib/observability/email.ts`; key + from come from the existing Resend alert config in
`settings`; a missing key is a 409 "Configure Resend under Settings → Activity & Alerts"). `RESEND_FAKE=1` in dev
logs the link instead of sending, which the browser test reads.

**Accept.** `/invite/<token>` is a public page. `GET /api/auth/invite/<token>` (public, under `/api/auth` so no
middleware change) returns `{ email, invitedBy, expired, used }`. Two paths:
- **Password:** `POST /api/auth/invite/<token>/accept` `{ name, password }` creates the `user` and
  `account(providerId='credential')` rows directly with better-auth's own hasher
  (`(await auth.$context).password.hash`), so `emailAndPassword.disableSignUp` stays true and the public sign-up
  gate is never opened. The first-owner hook does not fire on a direct insert, so the route sets `role='guest'`
  explicitly. It then marks the invite used, applies the grants and signs the user in (`auth.api.signInEmail`).
  These static routes (`server/api/auth/invite/**`) sit beside the better-auth catch-all
  (`server/api/auth/[...all].ts`); Nitro matches the static path first.
- **Google:** "Continue with Google" → `google-login` (section 2).

Tokens are single-use; an expired or used token renders a plain "This invite is no longer valid" page.

**Admin page `/settings/users`** (owner only; nav entry under Settings): users table (name, email, role, grants
toggles, daily quota, last session, today's usage, Google linked?), *Revoke* (sets `banned_at`, deletes sessions)
and *Restore*, *Reset password* (sets a temporary password shown once), and an *Invites* section (open invites with
resend/cancel; mint form). Routes: `GET /api/admin/users`, `PATCH /api/admin/users/:id` (grants, quota, ban),
`POST /api/admin/users/:id/reset-password`, `GET/POST/DELETE /api/admin/users/invites[/:id]`,
`POST /api/admin/users/invites/:id/resend`. All `requireOwner`.

## 4. Guest surface

**Layout** `app/layouts/playground.vue`: top bar only (Bridget wordmark, feature tabs rendered from `grants`,
account menu with sign out). No sidebar, no SSE plugin subscription, no presence beacon (`/api/events` and
`/api/presence` are not in `GUEST_PREFIXES`; the plugins skip when `role !== 'owner'`).

**Pages**
- `/play` hub: granted feature cards; a "nothing granted yet" state.
- `/play/voice`: shared-preset picker, text area (cap = the preset's `maxSegmentChars` × segments the planner
  allows; UI shows the limit), *Speak*, player with waveform (reuse the studio's player component), *Download WAV*,
  today's remaining quota.
- `/play/account`: name, change password, link Google.

**API (`server/api/play/**`)**, each handler thin, calling core services with the guest's `userId`:
- `GET /api/me` → `{ id, name, email, role, grants, usage: { [kind]: { used, limit } } }`.
- `GET /api/play/presets` → shared presets, `{ id, name, hasReference }` only.
- `POST /api/play/voice/speak` `{ presetId, text }` → `requireGrant('voice')` → `consumeQuota(userId,'voice')`
  (atomic `insert … on conflict do update … where count < limit`, 429 when exhausted) → the studio's
  `speakSegments` path at STUDIO priority, `format: 'wav'`, **no overrides** and `mode: 'quality'`. Refuses a
  preset that is not `shared`. Same segment planner and Breeze validation as `voice/speak.post.ts`; the two
  handlers share one helper rather than duplicating the pipeline.

## 5. Error handling

- Middleware 403 for guests is JSON `{ statusMessage: 'Forbidden: owner only' }`; the client's `$fetch` error hook
  redirects a guest to `/play` on 403 instead of showing a toast.
- Quota exhaustion is 429 with `{ used, limit, resetsAt }`; the page shows the reset time.
- Rig errors on the guest path return the same sanitized messages the studio uses (no rig URLs or stack text).
- Invite email failure: the invite row is still created and the admin page shows "email failed, copy link"
  (owner can paste it manually).

## 6. Testing

**Unit (vitest)**
- Middleware: guest session → 403 on `/api/documents`, `/api/events`, `/api/settings/tokens`; 200 on
  `/api/play/presets`, `/api/me`; owner session unaffected; owner `mm_` token unaffected; banned user 403 everywhere.
- First-owner hook: empty table → owner; second user → guest.
- Invite lifecycle: mint → accept (password) → used; accept twice → 410; expired → 410; grants snapshot applied;
  open-invite uniqueness per email.
- `google-login`: hook refuses an uninvited email; accepts an invited one and consumes the invite;
  `syncConnection` ignores `google-login` rows (no `connections` row created).
- Quota: `consumeQuota` is atomic under concurrency (two parallel calls at limit−1 → exactly one succeeds); day
  boundary follows `getDefaultTimezone()`, with a test that fails if the day were computed in UTC.
- `/api/play/voice/speak` refuses an unshared preset and ignores `overrides` in the body.

**Browser (`playwright-cli`, browser-testing skill)**
- Owner mints an invite with `RESEND_FAKE=1`; the test reads the logged link, opens it in a fresh context, accepts
  with a password, lands on `/play`, sees only *Voice*, speaks with a shared preset (asserts a WAV response and the
  player), is redirected from `/documents` to `/play`, and hits the quota wall after the limit (test lowers
  `dailyQuota` to 2 via the admin page).
- Owner revokes the guest; the guest's next request lands on `/login`.

## 7. Follow-ups logged for cycle 90

`generations` table (`user_id`, `kind`, prompt, status, storage key) + worker queue for long renders; music page
(heretic → structured caption → `minimax-music3` on audio.cpp `:8885`); image page over `generateImage`; owner
gallery filter by user; guest live updates if the queue needs them.
