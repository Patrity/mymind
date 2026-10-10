// Cycle 80 Task 2: the closure reads config via coreConfig(), which the 00.core Nitro plugin
// initialises at boot. Any config/db access before initCore() must fail loudly, not silently
// fall back. test/setup/core-bridge.ts initialises core for every test file, so reset first.
import { describe, it, expect } from 'vitest'
import { _resetCoreForTests, initCore } from '@mymind/core/config'
import { fromRuntimeConfig } from '../server/utils/core-config'
import { useDb } from '@mymind/core/db'
import { storage } from '@mymind/core/utils/storage'
import { googleConfigured } from '@mymind/core/lib/google/scopes'

describe('core init order', () => {
  it('useDb() before initCore() throws the not-initialised error', () => {
    _resetCoreForTests()
    expect(() => useDb()).toThrow('core not initialised — call initCore() first')
  })

  it('storage() and googleConfigured() before initCore() throw the same error', () => {
    _resetCoreForTests()
    expect(() => storage()).toThrow('core not initialised — call initCore() first')
    expect(() => googleConfigured()).toThrow('core not initialised — call initCore() first')
  })

  it('reads the initialised config once initCore() has run', () => {
    _resetCoreForTests()
    initCore(fromRuntimeConfig({ googleClientId: 'cid', googleClientSecret: 'secret' }))
    expect(googleConfigured()).toBe(true)
    _resetCoreForTests()
  })
})
