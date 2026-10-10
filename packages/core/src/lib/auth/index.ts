import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { mcp } from 'better-auth/plugins'
import { coreConfig, type CoreConfig } from '../../config'
import { useDb } from '../../db'
import { user, session, account, verification, oauthApplication, oauthAccessToken, oauthConsent } from '../../db/schema/auth'
import { oauthOrigin } from '../../utils/oauth-metadata'
import { eq } from 'drizzle-orm'
import { googleSocialProviders, GOOGLE_ACCOUNT_OPTIONS, GOOGLE_AUTH_HOOKS, DISABLED_AUTH_PATHS } from '../google/auth-options'
import { upsertConnectionForAccount } from '../google/connections'

type AccountHookRow = { id: string, providerId?: string, accountId?: string, userId?: string, idToken?: string | null, accessToken?: string | null }

/** Cycle 79: keep `connections` in step with Google account rows. better-auth 1.6.13 hands the
 *  hook the full row (create: the inserted row; update: the adapter's RETURNING row), with the
 *  access token already ENCRYPTED and idToken plaintext. If a future adapter ever returns a
 *  partial row, re-read it by id. Never throws — a connection bookkeeping failure must not
 *  break the OAuth link itself. */
async function syncConnection(kind: string, acc: AccountHookRow | null) {
  try {
    if (!acc?.id) return
    let row: AccountHookRow | undefined = acc
    if (!acc.providerId || !acc.accountId) {
      row = (await useDb().select().from(account).where(eq(account.id, acc.id)))[0]
    }
    if (!row?.providerId || !row.accountId || row.providerId !== 'google') return
    await upsertConnectionForAccount({ ...row, providerId: row.providerId, accountId: row.accountId })
  } catch (err) {
    console.warn(`[connections] ${kind} hook`, err)
  }
}

export function buildAuth(cfg: CoreConfig) {
  // Single-user, internet-exposed app: sign-up is DISABLED by default so the public
  // cannot self-register into the shared corpus. Set ALLOW_SIGNUP=true to bootstrap
  // your account, then unset it. Origins are derived from BETTER_AUTH_URL so this
  // works unchanged in production.
  const baseURL = cfg.betterAuthUrl as string
  return betterAuth({
    database: drizzleAdapter(useDb(), {
      provider: 'pg',
      schema: { user, session, account, verification, oauthApplication, oauthAccessToken, oauthConsent }
    }),
    secret: cfg.betterAuthSecret as string,
    baseURL,
    trustedOrigins: baseURL ? [baseURL] : [],
    // String() so this works whether allowSignup is the raw string 'true' (baked at
    // build time) or a boolean true (Nuxt coerces NUXT_ALLOW_SIGNUP=true via destr at runtime).
    emailAndPassword: { enabled: true, disableSignUp: String(cfg.allowSignup) !== 'true' },
    // Cycle 79: Google is link-only (Settings → Connections) — see server/lib/google/auth-options.ts
    // for why sign-up/ID-token sign-in are closed there. Absent entirely when unconfigured.
    // Same predicate as googleConfigured() (lib/google/scopes.ts), evaluated on `cfg` so
    // buildAuth stays a pure function of its argument.
    socialProviders: Boolean(cfg.googleClientId) && Boolean(cfg.googleClientSecret)
      ? googleSocialProviders(cfg.googleClientId as string, cfg.googleClientSecret as string)
      : undefined,
    account: GOOGLE_ACCOUNT_OPTIONS,
    hooks: GOOGLE_AUTH_HOOKS,
    disabledPaths: DISABLED_AUTH_PATHS,
    databaseHooks: {
      account: {
        create: { after: async acc => syncConnection('create', acc as AccountHookRow) },
        update: { after: async acc => syncConnection('update', acc as AccountHookRow | null) }
      }
    },
    plugins: [
      mcp({
        loginPage: '/login',
        resource: `${oauthOrigin(baseURL)}/api/mcp`,
        oidcConfig: {
          // OIDCOptions.loginPage is required at the type level (unlike MCPOptions.loginPage);
          // duplicated here to satisfy the type — see task-2-report.md for detail.
          loginPage: '/login',
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
}

let _auth: ReturnType<typeof buildAuth> | null = null

export function useAuth() {
  if (!_auth) _auth = buildAuth(coreConfig())
  return _auth
}
