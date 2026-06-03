import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { useDb } from '../db'
import { user, session, account, verification } from '../db/schema/auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null

export function useAuth() {
  if (_auth) return _auth as ReturnType<typeof betterAuth>
  const cfg = useRuntimeConfig()
  _auth = betterAuth({
    database: drizzleAdapter(useDb(), { provider: 'pg', schema: { user, session, account, verification } }),
    secret: cfg.betterAuthSecret as string,
    baseURL: cfg.betterAuthUrl as string,
    trustedOrigins: ['http://localhost:3000'],
    emailAndPassword: { enabled: true }
  })
  return _auth as ReturnType<typeof betterAuth>
}
