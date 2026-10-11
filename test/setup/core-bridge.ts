// Cycle 80 Task 2 — test-harness bridge (both vitest configs load this as a setupFile).
//
// The server closure no longer reads Nitro globals: config comes from coreConfig() and HTTP from
// an explicit `ofetch` import. ~85 existing test files still configure the code under test the
// pre-cycle-80 way — `vi.stubGlobal('useRuntimeConfig', ...)` and `vi.stubGlobal('$fetch', ...)`.
// Rather than hand-edit them all, this bridge routes both through to whatever the test stubbed,
// resolved LAZILY at each access (tests stub after imports, re-stub mid-file, mutate the object):
//   - core is initialised with a Proxy whose every field read is
//     fromRuntimeConfig(globalThis.useRuntimeConfig())[field] — the REAL mapper, so a test still
//     only sees what prod would map from the same runtimeConfig;
//   - `ofetch` is mocked to call globalThis.$fetch.
// With no stub present both throw, as the bare global did before (ReferenceError).
// A test that needs real core state calls _resetCoreForTests() + initCore() itself
// (test/core-init-order.test.ts); a test that vi.resetModules() gets a fresh, uninitialised
// config module and must initCore() again (test/auth-google-wiring.test.ts).
import { vi } from 'vitest'
import { initCore, type CoreConfig } from '@mymind/core/config'
import { fromRuntimeConfig } from '../../server/utils/core-config'
import { ENV_BACKED_FIELDS, envBacked } from '@mymind/core/config-env'

vi.mock('ofetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ofetch')>()
  const viaGlobal = (...args: unknown[]) => {
    const f = (globalThis as { $fetch?: (...a: unknown[]) => unknown }).$fetch
    if (typeof f !== 'function') throw new ReferenceError('$fetch is not defined (stub it with vi.stubGlobal)')
    return f(...args)
  }
  return { ...actual, ofetch: viaGlobal, $fetch: viaGlobal }
})

function runtimeConfig(): Record<string, unknown> {
  const rc = (globalThis as { useRuntimeConfig?: () => Record<string, unknown> }).useRuntimeConfig
  if (typeof rc !== 'function') throw new ReferenceError('useRuntimeConfig is not defined (stub it with vi.stubGlobal)')
  return rc()
}

// Cycle 81: the env-backed fields (busNs, agentExecutor) and the `dev` host flag never came from
// useRuntimeConfig, so they resolve without a stub: env-backed ones from process.env at each access
// (vi.stubEnv works), `dev` false (vitest is not a dev server — as import.meta.dev was undefined).
const envKeys: ReadonlySet<string | symbol> = new Set<string>(ENV_BACKED_FIELDS)
initCore(new Proxy({} as CoreConfig, {
  get: (_target, key) => {
    if (key === 'dev') return false
    if (envKeys.has(key)) return (envBacked(process.env) as Record<string | symbol, unknown>)[key]
    return (fromRuntimeConfig(runtimeConfig()) as unknown as Record<string | symbol, unknown>)[key]
  }
}))
