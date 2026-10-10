import { beforeEach, describe, expect, it } from 'vitest'
import { _resetCoreForTests, coreConfig, initCore, type CoreConfig } from './config'

// CoreConfig is intentionally empty until Task 2 fills it with the exact fields core reads.
// These tests exercise the init/get/reset contract itself, so a couple of cases cast past
// the empty interface to stand in for "some config object" vs. "a different config object".

beforeEach(() => {
  _resetCoreForTests()
})

describe('initCore / coreConfig', () => {
  it('coreConfig() throws before initCore() has been called', () => {
    expect(() => coreConfig()).toThrow('core not initialised — call initCore() first')
  })

  it('coreConfig() returns the object passed to initCore()', () => {
    const cfg: CoreConfig = {}
    initCore(cfg)
    expect(coreConfig()).toBe(cfg)
  })

  it('a second initCore() call with an equal object is a no-op', () => {
    initCore({})
    expect(() => initCore({})).not.toThrow()
    expect(coreConfig()).toEqual({})
  })

  it('a second initCore() call with a different object throws', () => {
    initCore({} as CoreConfig)
    const different = { extra: true } as unknown as CoreConfig
    expect(() => initCore(different)).toThrow()
  })

  it('_resetCoreForTests() clears state so coreConfig() throws again', () => {
    initCore({})
    _resetCoreForTests()
    expect(() => coreConfig()).toThrow('core not initialised — call initCore() first')
  })
})
