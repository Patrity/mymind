// Cycle 79: the security options proven in server/lib/google/auth-options.test.ts only protect
// production if server/lib/auth (re-exported by server/utils/auth.ts) actually wires them into the REAL useAuth() instance.
// Builds the real instance (no DB connection is opened at construction) and checks the wiring.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg: Record<string, unknown> = {}
vi.stubGlobal('useRuntimeConfig', () => cfg)

async function freshAuth() {
  vi.resetModules()
  // Cycle 80: resetModules also drops the core config module the setup bridge initialised, so
  // re-init the fresh one from the same runtimeConfig (via the real mapper, as 00.core does).
  const { initCore } = await import('@mymind/core/config')
  const { fromRuntimeConfig } = await import('../server/utils/core-config')
  initCore(fromRuntimeConfig(cfg))
  const mod = await import('../server/utils/auth')
  return mod.useAuth()
}

beforeEach(() => {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, {
    databaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
    betterAuthSecret: 'test-secret-test-secret-test-secret-0123',
    betterAuthUrl: 'http://localhost:3000',
    allowSignup: 'false',
    googleClientId: '',
    googleClientSecret: ''
  })
})

describe('useAuth() google wiring', () => {
  it('always wires the sign-in block, disabled token paths, account options and account hooks', async () => {
    const auth = await freshAuth()
    // Same module registry as the freshly imported auth.ts (vi.resetModules), so identity holds.
    const { GOOGLE_AUTH_HOOKS, DISABLED_AUTH_PATHS, GOOGLE_ACCOUNT_OPTIONS } = await import('@mymind/core/lib/google/auth-options')
    expect(auth.options.hooks).toBe(GOOGLE_AUTH_HOOKS)
    expect(auth.options.disabledPaths).toEqual(DISABLED_AUTH_PATHS)
    expect(auth.options.account).toBe(GOOGLE_ACCOUNT_OPTIONS)
    expect(typeof auth.options.databaseHooks?.account?.create?.after).toBe('function')
    expect(typeof auth.options.databaseHooks?.account?.update?.after).toBe('function')
  })

  it('omits socialProviders when Google is not configured', async () => {
    const auth = await freshAuth()
    expect(auth.options.socialProviders).toBeUndefined()
  })

  it('adds the link-only google provider when both client values are set', async () => {
    cfg.googleClientId = 'cid'
    cfg.googleClientSecret = 'secret'
    const auth = await freshAuth()
    expect(auth.options.socialProviders?.google).toMatchObject({
      clientId: 'cid', clientSecret: 'secret', disableSignUp: true, disableIdTokenSignIn: true
    })
  })
})
