# MCP OAuth Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MyMind's MCP server (`/api/mcp`) addable as a claude.ai / Claude Desktop custom connector by turning better-auth into the OAuth 2.1 provider via its `mcp` plugin.

**Architecture:** The better-auth `mcp` plugin (already-installed better-auth 1.6.13) provides authorize/token/register/consent endpoints under the existing `/api/auth/*` mount (already public in middleware). We add: three drizzle tables the plugin needs, two root-level well-known metadata routes, an OAuth branch in the auth middleware with the RFC 9728 discovery challenge header, a consent page, and a post-login bounce in `login.vue`.

**Tech Stack:** Nuxt 4 / Nitro / h3, better-auth 1.6.13 (`mcp` plugin), drizzle + Postgres, vitest, playwright-cli.

**Spec:** `docs/superpowers/specs/2026-07-17-mcp-oauth-connector-design.md`

## Global Constraints

- pnpm only. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`. Lint is red repo-wide and is NOT a gate.
- Branch: `feat/mcp-oauth` (created from `master` in an isolated worktree — the main working dir has in-flight galaxy changes; do not touch `nuxt.config.ts`, `server/api/graph/**`, `server/services/graph.ts`, `server/tasks/compute-graph-layout.ts`).
- Conventional commits (`feat(mcp-oauth): …`).
- Consent must NEVER auto-approve (spec security rule).
- Copy rule: the OAuth flow mints better-auth OAuth tokens, NOT `mm_` api tokens. `api_tokens` is untouched.
- Vue work: Nuxt UI v4 components + semantic color tokens only (see `.claude/rules/web-vue-ui.md`); invoke `nuxt-ui-docs` before using a component.
- better-auth endpoint paths (verified from dist): authorize `GET /api/auth/mcp/authorize`, token `POST /api/auth/mcp/token`, register `POST /api/auth/mcp/register`, consent `POST /api/auth/oauth2/consent`, session check `auth.api.getMcpSession({ headers })`. Discovery metadata advertises the `/mcp/*` paths — never hardcode them client-side.

---

### Task 1: OAuth tables (schema + migration 0029)

**Files:**
- Modify: `server/db/schema/auth.ts`
- Verify barrel: `server/db/schema/index.ts` (or `server/db/schema.ts`) re-exports `./auth` — if it lists exports explicitly, add the three new tables.
- Generated: `server/db/migrations/0029_*.sql` (via drizzle-kit)

**Interfaces:**
- Produces: drizzle tables `oauthApplication`, `oauthAccessToken`, `oauthConsent` exported from `server/db/schema/auth.ts` (consumed by Task 2's drizzleAdapter schema).

Field set is transcribed from `node_modules/better-auth/dist/plugins/oidc-provider/schema.mjs` (the authority — re-check it if anything fails at runtime). `refreshToken`/`refreshTokenExpiresAt` are deliberately nullable (looser than upstream; safe if a client skips `offline_access`).

- [ ] **Step 1: Add the three tables to `server/db/schema/auth.ts`** (append; match existing better-auth table style — text ids, snake_case columns):

```ts
export const oauthApplication = pgTable('oauth_application', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  metadata: text('metadata'),
  clientId: text('client_id').notNull().unique(),
  clientSecret: text('client_secret'),
  redirectUrls: text('redirect_urls').notNull(),
  type: text('type').notNull(),
  disabled: boolean('disabled').default(false),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const oauthAccessToken = pgTable('oauth_access_token', {
  id: text('id').primaryKey(),
  accessToken: text('access_token').notNull().unique(),
  refreshToken: text('refresh_token').unique(),
  accessTokenExpiresAt: timestamp('access_token_expires_at').notNull(),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  clientId: text('client_id').notNull()
    .references(() => oauthApplication.clientId, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  scopes: text('scopes').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const oauthConsent = pgTable('oauth_consent', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull()
    .references(() => oauthApplication.clientId, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  scopes: text('scopes').notNull(),
  consentGiven: boolean('consent_given').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: new file `server/db/migrations/0029_*.sql` containing `CREATE TABLE "oauth_application" | "oauth_access_token" | "oauth_consent"`. Inspect it — it must NOT touch any existing table.

- [ ] **Step 3: Apply locally**

Run: `pnpm db:migrate`
Expected: exits 0. Then `pnpm typecheck` — exits 0.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema/auth.ts server/db/migrations
git commit -m "feat(mcp-oauth): oauth_application/access_token/consent tables (migration 0029)"
```

---

### Task 2: Register the `mcp` plugin + challenge-header util

**Files:**
- Modify: `server/utils/auth.ts`
- Create: `server/utils/oauth-metadata.ts`
- Test: `server/utils/oauth-metadata.test.ts`

**Interfaces:**
- Consumes: Task 1's `oauthApplication`, `oauthAccessToken`, `oauthConsent` exports.
- Produces: `mcpAuthChallengeHeader(origin: string): string` and `oauthOrigin(betterAuthUrl: string | undefined): string` from `server/utils/oauth-metadata.ts` (consumed by Tasks 3–4). better-auth instance now has the `mcp` plugin (endpoints + `auth.api.getMcpSession`).

- [ ] **Step 1: Write failing tests** — `server/utils/oauth-metadata.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mcpAuthChallengeHeader, oauthOrigin } from './oauth-metadata'

describe('oauthOrigin', () => {
  it('reduces a full URL to its origin', () => {
    expect(oauthOrigin('https://brain.costanzoclan.com/api/auth')).toBe('https://brain.costanzoclan.com')
  })
  it('falls back to localhost dev origin when unset', () => {
    expect(oauthOrigin(undefined)).toBe('http://localhost:3000')
  })
})

describe('mcpAuthChallengeHeader', () => {
  it('points at the protected-resource metadata on the given origin', () => {
    expect(mcpAuthChallengeHeader('https://brain.costanzoclan.com')).toBe(
      'Bearer resource_metadata="https://brain.costanzoclan.com/.well-known/oauth-protected-resource"'
    )
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/utils/oauth-metadata.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/utils/oauth-metadata.ts`**

```ts
/** Origin (scheme+host) of the public deployment, from BETTER_AUTH_URL. */
export function oauthOrigin(betterAuthUrl: string | undefined): string {
  if (!betterAuthUrl) return 'http://localhost:3000'
  return new URL(betterAuthUrl).origin
}

/**
 * RFC 9728 challenge for 401s on /api/mcp — Claude reads this header to
 * discover the protected-resource metadata and start its OAuth flow.
 */
export function mcpAuthChallengeHeader(origin: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run server/utils/oauth-metadata.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the plugin in `server/utils/auth.ts`** — new imports + plugin block. The import of `mcp` comes from `better-auth/plugins`:

```ts
import { mcp } from 'better-auth/plugins'
import { user, session, account, verification, oauthApplication, oauthAccessToken, oauthConsent } from '../db/schema/auth'
import { oauthOrigin } from './oauth-metadata'
```

Inside `betterAuth({...})`: extend the adapter schema and add `plugins`:

```ts
_auth = betterAuth({
  database: drizzleAdapter(useDb(), {
    provider: 'pg',
    schema: { user, session, account, verification, oauthApplication, oauthAccessToken, oauthConsent }
  }),
  secret: cfg.betterAuthSecret as string,
  baseURL,
  trustedOrigins: baseURL ? [baseURL] : [],
  emailAndPassword: { enabled: true, disableSignUp: String(cfg.allowSignup) !== 'true' },
  plugins: [
    mcp({
      loginPage: '/login',
      resource: `${oauthOrigin(baseURL)}/api/mcp`,
      oidcConfig: {
        consentPage: '/oauth/consent',
        allowDynamicClientRegistration: true,
        requirePKCE: true,
        // 30d refresh (default 7d): an unused personal connector shouldn't
        // force re-consent weekly. Access token stays at the 1h default.
        refreshTokenExpiresIn: 60 * 60 * 24 * 30
      }
    })
  ]
})
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. If the `mcp` options type rejects a key, re-check `node_modules/better-auth/dist/plugins/mcp/index.d.mts` (`MCPOptions`) and `.../oidc-provider/types.d.mts` (`OIDCOptions`) — the dist types are the authority, not docs.

- [ ] **Step 7: Commit**

```bash
git add server/utils/auth.ts server/utils/oauth-metadata.ts server/utils/oauth-metadata.test.ts
git commit -m "feat(mcp-oauth): better-auth mcp plugin (open DCR, PKCE, 30d refresh) + challenge-header util"
```

---

### Task 3: Root well-known metadata routes

**Files:**
- Create: `server/routes/.well-known/oauth-authorization-server.get.ts`
- Create: `server/routes/.well-known/oauth-protected-resource.get.ts`
- Create: `server/routes/.well-known/oauth-protected-resource/api/mcp.get.ts`

**Interfaces:**
- Consumes: `useAuth()` (Task 2, now with mcp plugin); better-auth exports `oAuthDiscoveryMetadata` and `oAuthProtectedResourceMetadata` from `better-auth/plugins`.
- Produces: public metadata documents at the origin root that Claude probes. `server/routes/**` is outside the `/api/**` middleware guard, so these are public automatically.

- [ ] **Step 1: Verify the helper signatures** (they are typed for Next-style handlers):

Run: `rg -n "oAuthDiscoveryMetadata|oAuthProtectedResourceMetadata" node_modules/better-auth/dist/plugins/mcp/index.d.mts`
Expected: both exported as `(auth) => (request: Request) => Promise<Response>` (or similar). If `oAuthProtectedResourceMetadata` takes an options arg, pass nothing — the `resource` was configured on the plugin in Task 2.

- [ ] **Step 2: Create the discovery route** — `server/routes/.well-known/oauth-authorization-server.get.ts`:

```ts
import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { useAuth } from '../../utils/auth'

// RFC 8414 authorization-server metadata, served at the origin root where
// MCP clients (Claude) probe for it. Delegates to better-auth so the
// advertised endpoints always match the plugin's real routes.
export default defineEventHandler((event) =>
  oAuthDiscoveryMetadata(useAuth())(toWebRequest(event))
)
```

- [ ] **Step 3: Create the protected-resource routes** — `server/routes/.well-known/oauth-protected-resource.get.ts` and `server/routes/.well-known/oauth-protected-resource/api/mcp.get.ts`, both:

```ts
import { oAuthProtectedResourceMetadata } from 'better-auth/plugins'
import { useAuth } from '../../utils/auth'
// (three-level relative path '../../../../utils/auth' in the api/mcp variant)

// RFC 9728 protected-resource metadata. Claude probes both the bare path and
// the /api/mcp-suffixed variant; serve the same document from both.
export default defineEventHandler((event) =>
  oAuthProtectedResourceMetadata(useAuth())(toWebRequest(event))
)
```

- [ ] **Step 4: Live-verify against the dev server**

Run (dev server up via `pnpm dev`):
```bash
curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq '{issuer, authorization_endpoint, token_endpoint, registration_endpoint, code_challenge_methods_supported}'
curl -s http://localhost:3000/.well-known/oauth-protected-resource | jq '{resource, authorization_servers}'
curl -s http://localhost:3000/.well-known/oauth-protected-resource/api/mcp | jq .resource
```
Expected: discovery doc advertises `/api/auth/mcp/authorize|token|register` on the dev origin and `code_challenge_methods_supported: ["S256"]`; both PRM docs return `"resource": "http://localhost:3000/api/mcp"` exactly.

- [ ] **Step 5: Commit**

```bash
git add server/routes
git commit -m "feat(mcp-oauth): root well-known discovery + protected-resource metadata routes"
```

---

### Task 4: Middleware — OAuth tokens on /api/mcp + challenge header

**Files:**
- Modify: `server/middleware/auth.ts`
- Check-and-update: the `event.context.client` type union — find it with `rg -n "type: 'api-token'|'api-token' \|" server shared` and add an `'oauth'` variant alongside; update any exhaustive consumers (grep for `client.type`).

**Interfaces:**
- Consumes: `mcpAuthChallengeHeader`, `oauthOrigin` (Task 2); `useAuth().api.getMcpSession({ headers })` → `OAuthAccessToken | null`.
- Produces: `/api/mcp` accepts OAuth bearer tokens; ALL 401s on `/api/mcp` (missing header included) carry the resource_metadata challenge. `event.context.client = { type: 'oauth', tokenId, userId }`.

- [ ] **Step 1: Rewrite `server/middleware/auth.ts`** (complete file — current behavior preserved for everything except `/api/mcp`):

```ts
import { eq, and, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { apiTokens } from '../db/schema'
import { hashToken } from '../utils/api-token'
import { mcpAuthChallengeHeader, oauthOrigin } from '../utils/oauth-metadata'

const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/setup', '/api/health']

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event).pathname
  if (!url.startsWith('/api/') && url !== '/api') return
  if (PUBLIC_PREFIXES.some(p => url === p || url.startsWith(p + '/'))) return

  const isMcp = url === '/api/mcp' || url.startsWith('/api/mcp/')
  const unauthorized = () => {
    // On the MCP route the 401 carries the RFC 9728 pointer Claude needs to
    // bootstrap OAuth discovery; everywhere else keep the bare challenge.
    setResponseHeader(event, 'www-authenticate', isMcp
      ? mcpAuthChallengeHeader(oauthOrigin(useRuntimeConfig().betterAuthUrl as string | undefined))
      : 'Bearer')
    return createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  // 1) bearer API token (machine clients)
  const authz = getHeader(event, 'authorization')
  if (authz?.startsWith('Bearer ')) {
    const db = useDb()
    const [row] = await db.select().from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hashToken(authz.slice(7))), isNull(apiTokens.revokedAt)))
      .limit(1)
    if (row) {
      event.context.client = { type: 'api-token', tokenId: row.id }
      // Fire-and-forget lastUsedAt update — errors are intentionally swallowed
      db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).execute().catch(() => {})
      return
    }
    // 1b) OAuth access token (MCP connectors) — only on the MCP route
    if (isMcp) {
      const oauthToken = await useAuth().api.getMcpSession({ headers: event.headers as Headers }).catch(() => null)
      if (oauthToken) {
        event.context.client = { type: 'oauth', tokenId: oauthToken.id, userId: oauthToken.userId ?? undefined }
        return
      }
    }
    throw unauthorized()
  }

  // 2) session (web app)
  // better-auth 1.6.13: api.getSession requires { headers: HeadersInit }
  // H3 v2 event.headers is a native Headers object (implements HeadersInit)
  const session = await useAuth().api.getSession({ headers: event.headers as Headers }).catch(() => null)
  if (session?.user) {
    event.context.user = session.user
    event.context.client = { type: 'session', userId: session.user.id }
    return
  }

  throw unauthorized()
})
```

- [ ] **Step 2: Fix the client type union.** Locate the type of `event.context.client` (grep above). Add:

```ts
| { type: 'oauth', tokenId: string, userId?: string }
```

Run `pnpm typecheck` and fix any consumer that switches exhaustively on `client.type`.

- [ ] **Step 3: Live-verify the 401 shapes**

Run (dev server up):
```bash
curl -si -X POST http://localhost:3000/api/mcp -H 'content-type: application/json' -d '{}' | rg -i 'HTTP/|www-authenticate'
curl -si -X POST http://localhost:3000/api/mcp -H 'authorization: Bearer garbage' -H 'content-type: application/json' -d '{}' | rg -i 'HTTP/|www-authenticate'
curl -si http://localhost:3000/api/documents | rg -i 'HTTP/|www-authenticate'
```
Expected: first two → `401` with `www-authenticate: Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"`; third → `401` with bare `www-authenticate: Bearer`.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: green (existing middleware behavior unchanged for mm_ tokens/sessions).

- [ ] **Step 5: Commit**

```bash
git add server/middleware/auth.ts
git commit -m "feat(mcp-oauth): accept OAuth bearers on /api/mcp + RFC 9728 challenge on 401"
```
(Include the client-type union file in the `git add` if modified.)

---

### Task 5: Consent page + login bounce

**Files:**
- Create: `app/pages/oauth/consent.vue`
- Modify: `app/pages/login.vue` (post-login redirect)

**Interfaces:**
- Consumes: better-auth consent endpoint `POST /api/auth/oauth2/consent` body `{ accept: boolean, consent_code: string }` → `{ redirectURI: string }`. Authorize redirects here with query `consent_code`, `client_id` (+ `scope` when present). Unauthed authorize redirects to `/login?<original authorize query>`.
- Produces: browser consent UX; login page that resumes the OAuth flow.

Note: invoke the `nuxt-ui-docs` skill before writing the components (Nuxt UI v4; semantic color tokens only).

- [ ] **Step 1: Create `app/pages/oauth/consent.vue`**

```vue
<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const consentCode = computed(() => (route.query.consent_code as string) ?? '')
const clientId = computed(() => (route.query.client_id as string) ?? 'Unknown client')
const scopes = computed(() => ((route.query.scope as string) ?? '').split(' ').filter(Boolean))

const error = ref<string | null>(null)
const loading = ref<'approve' | 'deny' | null>(null)

async function decide(accept: boolean) {
  error.value = null
  loading.value = accept ? 'approve' : 'deny'
  try {
    const res = await $fetch<{ redirectURI: string }>('/api/auth/oauth2/consent', {
      method: 'POST',
      body: { accept, consent_code: consentCode.value }
    })
    window.location.href = res.redirectURI
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Consent request failed'
    loading.value = null
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default p-4">
    <UCard class="w-full max-w-md">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-brain" class="size-6 text-primary" />
          <span class="font-semibold">Connection request</span>
        </div>
      </template>

      <UAlert
        v-if="error"
        color="error"
        :title="error"
        icon="i-lucide-circle-alert"
        class="mb-4"
      />

      <p class="text-default mb-2">
        <span class="font-mono text-sm bg-muted px-1.5 py-0.5 rounded">{{ clientId }}</span>
        is asking to access your MyMind account.
      </p>
      <ul v-if="scopes.length" class="text-sm text-muted list-disc ms-5 mb-2">
        <li v-for="s in scopes" :key="s">{{ s }}</li>
      </ul>
      <p class="text-sm text-dimmed">
        Only approve if you initiated this connection yourself (for example, adding
        MyMind as a connector in Claude).
      </p>

      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" :loading="loading === 'deny'" @click="decide(false)">
            Deny
          </UButton>
          <UButton color="primary" :loading="loading === 'approve'" @click="decide(true)">
            Approve
          </UButton>
        </div>
      </template>
    </UCard>
  </div>
</template>
```

- [ ] **Step 2: Add the OAuth bounce to `app/pages/login.vue`.** In `onSubmit`, replace the success branch `await navigateTo('/documents')`:

```ts
const route = useRoute()
// ...inside onSubmit, on success:
if (route.query.client_id && route.query.response_type) {
  // Login was reached mid-OAuth-flow (better-auth bounced the authorize
  // request here with its full query). Resume the flow server-side.
  const qs = new URLSearchParams(route.query as Record<string, string>).toString()
  await navigateTo(`/api/auth/mcp/authorize?${qs}`, { external: true })
} else {
  await navigateTo('/documents')
}
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: both green.

- [ ] **Step 4: Browser-verify the pages render** (per `browser-testing` skill: real login, snapshot). Visit `/oauth/consent?client_id=test-client&scope=openid%20offline_access&consent_code=fake` logged-in; expect the card with client id + scopes; clicking Approve surfaces an error alert (fake code) rather than a blank page.

- [ ] **Step 5: Commit**

```bash
git add app/pages/oauth/consent.vue app/pages/login.vue
git commit -m "feat(mcp-oauth): consent page + login OAuth-flow resume"
```

---

### Task 6: End-to-end OAuth flow verification (scripted)

**Files:**
- Create: `scripts/mcp-oauth-e2e.mjs` (dev-only helper; committed for reuse)

**Interfaces:**
- Consumes: everything from Tasks 1–5 against a running `pnpm dev` server with a logged-in browser (playwright-cli) for the authorize/consent leg.

The full proof without Claude: register a client via DCR → authorize with PKCE in a real browser (login + consent) → capture the code → exchange at the token endpoint → call `/api/mcp` with the minted access token.

- [ ] **Step 1: Create `scripts/mcp-oauth-e2e.mjs`**

```js
// Usage: node scripts/mcp-oauth-e2e.mjs <base> <code|""> [verifier] [client_id]
//   Phase 1 (no code): registers a DCR client, prints the authorize URL + verifier + client_id.
//   Phase 2 (code + verifier + client_id): exchanges the code, calls /api/mcp, prints results.
import { createHash, randomBytes } from 'node:crypto'

const [base = 'http://localhost:3000', code = '', verifierArg = '', clientIdArg = ''] = process.argv.slice(2)
const REDIRECT = 'http://127.0.0.1:19191/cb' // never listened on; we read the code off the URL bar

if (!code) {
  const reg = await fetch(`${base}/api/auth/mcp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mcp-oauth-e2e',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  }).then(r => r.json())
  if (!reg.client_id) throw new Error('DCR failed: ' + JSON.stringify(reg))

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid profile offline_access',
    state: 'e2e-state',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })
  console.log('VERIFIER=' + verifier)
  console.log('CLIENT_ID=' + reg.client_id)
  console.log('AUTHORIZE_URL=' + `${base}/api/auth/mcp/authorize?${q}`)
} else {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifierArg,
    client_id: clientIdArg // required for public clients (OAuth 2.1 §4.1.3)
  })
  const tok = await fetch(`${base}/api/auth/mcp/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  }).then(r => r.json())
  if (!tok.access_token) throw new Error('token exchange failed: ' + JSON.stringify(tok))
  console.log('TOKEN_OK expires_in=' + tok.expires_in + ' refresh=' + Boolean(tok.refresh_token))

  const mcp = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'authorization': `Bearer ${tok.access_token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })
  const text = await mcp.text()
  console.log('MCP_STATUS=' + mcp.status)
  console.log('MCP_HAS_TOOLS=' + text.includes('"tools"'))
}
```

- [ ] **Step 2: Phase 1 — register + build authorize URL**

Run: `node scripts/mcp-oauth-e2e.mjs http://localhost:3000 ""`
Expected: prints `VERIFIER=…`, `CLIENT_ID=…`, and `AUTHORIZE_URL=…`.

- [ ] **Step 3: Drive the browser leg with playwright-cli** (per `browser-testing` skill): open `AUTHORIZE_URL` in a fresh context → expect redirect to `/login?…` → sign in with the dev test account → expect `/oauth/consent?…` → real-click **Approve** → the browser attempts `http://127.0.0.1:19191/cb?code=…&state=e2e-state` (connection refused is fine) → read the `code` from the final URL.

- [ ] **Step 4: Phase 2 — token exchange + MCP call**

Run: `node scripts/mcp-oauth-e2e.mjs http://localhost:3000 "<code>" "<verifier>" "<client_id>"`
Expected: `TOKEN_OK expires_in=3600 refresh=true`, `MCP_STATUS=200`, `MCP_HAS_TOOLS=true`.

- [ ] **Step 5: Full gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/mcp-oauth-e2e.mjs
git commit -m "feat(mcp-oauth): scripted E2E for the DCR/PKCE/consent/token/mcp flow"
```

---

### Task 7: Wiki + handover

**Files:**
- Modify: `docs/wiki/mcp.md` — add an "Authentication" section describing the two auth paths (mm_ bearer for header-capable clients like Claude Code; OAuth for claude.ai connectors), the well-known routes, the consent rule, and the three new tables.
- Create: `docs/handovers/2026-07-17-mcp-oauth-connector.md` — standard handover frontmatter (`title`, `date`, `branch`, `status`, `spec`, `plan`), what shipped, how it was verified (Task 6 E2E), what's deferred (DCR cleanup cron follow-up task; request-headers beta path), prod-verification checklist (connector add on claude.ai).

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/wiki/mcp.md`** with the real shipped behavior (read the page first; keep its structure; wiki = current behavior, not intent).
- [ ] **Step 2: Create the handover** following the frontmatter style of the most recent file in `docs/handovers/`.
- [ ] **Step 3: Commit**

```bash
git add docs/wiki/mcp.md docs/handovers/2026-07-17-mcp-oauth-connector.md
git commit -m "docs(mcp-oauth): wiki auth section + handover"
```

---

## Post-plan (driven by the orchestrating session, not plan tasks)

Merge `feat/mcp-oauth` → `master`, push, deploy + migrate per the `prod-deploy` skill, verify the public well-known docs + 401 challenge on `https://brain.costanzoclan.com`, then hand Tony the connector instructions (URL `https://brain.costanzoclan.com/api/mcp`, no client id/secret, approve consent when redirected).
