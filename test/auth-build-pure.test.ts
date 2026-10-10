// Cycle 80 Task 2 fix round 1: buildAuth(cfg) decides Google wiring from `cfg` alone and never
// reads the global coreConfig(). The DB handle is the shared useDb() singleton by design, so it
// is mocked here. Core is left UNINITIALISED, so any coreConfig() read inside buildAuth throws.
import { describe, it, expect, vi } from 'vitest'
import { _resetCoreForTests } from '@mymind/core/config'
import { fromRuntimeConfig } from '../server/utils/core-config'

vi.mock('../server/db', () => ({ useDb: () => ({}) }))

import { buildAuth } from '../server/lib/auth'

const base = {
  databaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  betterAuthSecret: 'test-secret-test-secret-test-secret-0123',
  betterAuthUrl: 'http://localhost:3000',
  allowSignup: 'false'
}

describe('buildAuth(cfg) is a function of cfg', () => {
  it('wires the google provider from cfg with core uninitialised', () => {
    _resetCoreForTests()
    const auth = buildAuth(fromRuntimeConfig({ ...base, googleClientId: 'cid', googleClientSecret: 'secret' }))
    expect(auth.options.socialProviders?.google).toMatchObject({ clientId: 'cid', clientSecret: 'secret' })
  })

  it('omits google when cfg lacks either client value, with core uninitialised', () => {
    _resetCoreForTests()
    expect(buildAuth(fromRuntimeConfig({ ...base, googleClientId: 'cid', googleClientSecret: '' })).options.socialProviders).toBeUndefined()
    expect(buildAuth(fromRuntimeConfig({ ...base, googleClientId: '', googleClientSecret: 'secret' })).options.socialProviders).toBeUndefined()
  })
})
