import { beforeEach, describe, expect, it } from 'vitest'
import { _resetCoreForTests, coreConfig, initCore, type CoreConfig } from './config'

// These tests exercise the init/get/reset contract itself, so they cast `{}` past CoreConfig's
// required fields to stand in for "some config object" vs. "a different config object".

beforeEach(() => {
  _resetCoreForTests()
})

describe('initCore / coreConfig', () => {
  it('coreConfig() throws before initCore() has been called', () => {
    expect(() => coreConfig()).toThrow('core not initialised — call initCore() first')
  })

  it('coreConfig() returns the object passed to initCore()', () => {
    const cfg = {} as CoreConfig
    initCore(cfg)
    expect(coreConfig()).toBe(cfg)
  })

  it('a second initCore() call with an equal object is a no-op', () => {
    initCore({} as CoreConfig)
    expect(() => initCore({} as CoreConfig)).not.toThrow()
    expect(coreConfig()).toEqual({})
  })

  it('a second initCore() call with a different object throws', () => {
    initCore({} as CoreConfig)
    const different = { extra: true } as unknown as CoreConfig
    expect(() => initCore(different)).toThrow()
  })

  it('_resetCoreForTests() clears state so coreConfig() throws again', () => {
    initCore({} as CoreConfig)
    _resetCoreForTests()
    expect(() => coreConfig()).toThrow('core not initialised — call initCore() first')
  })
})
