import { describe, expect, it } from 'vitest'
import { _resetCoreForTests, coreConfig, initCore } from '@mymind/core/config'

// Proves the @mymind/core workspace package resolves from a root-level import path, exactly
// as app/server code will consume it from Task 2 onward.
describe('@mymind/core/config resolution', () => {
  it('resolves and exposes initCore/coreConfig from the package subpath export', () => {
    _resetCoreForTests()
    expect(() => coreConfig()).toThrow()
    initCore({})
    expect(coreConfig()).toEqual({})
    _resetCoreForTests()
  })
})
