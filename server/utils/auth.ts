import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { mcp } from 'better-auth/plugins'
import { useDb } from '../db'
import { user, session, account, verification, oauthApplication, oauthAccessToken, oauthConsent } from '../db/schema/auth'
import { oauthOrigin } from './oauth-metadata'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null

export function useAuth() {
  if (_auth) return _auth as ReturnType<typeof betterAuth>
  const cfg = useRuntimeConfig()
  // Single-user, internet-exposed app: sign-up is DISABLED by default so the public
  // cannot self-register into the shared corpus. Set ALLOW_SIGNUP=true to bootstrap
  // your account, then unset it. Origins are derived from BETTER_AUTH_URL so this
  // works unchanged in production.
  const baseURL = cfg.betterAuthUrl as string
  _auth = betterAuth({
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
  return _auth as ReturnType<typeof betterAuth>
}
