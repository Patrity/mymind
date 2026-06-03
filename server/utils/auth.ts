import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { useDb } from '../db'
import { user, session, account, verification } from '../db/schema/auth'

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
    database: drizzleAdapter(useDb(), { provider: 'pg', schema: { user, session, account, verification } }),
    secret: cfg.betterAuthSecret as string,
    baseURL,
    trustedOrigins: baseURL ? [baseURL] : [],
    emailAndPassword: { enabled: true, disableSignUp: cfg.allowSignup !== 'true' }
  })
  return _auth as ReturnType<typeof betterAuth>
}
