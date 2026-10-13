// Cycle 82 Task 3 fix round 1 (M1, M2): the sandbox's secret masking rules.
import { describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ all: {} as Record<string, string>, opted: {} as Record<string, string> }))
vi.mock('../exec/secrets', () => ({
  getDecryptedSecrets: async () => ({ ...store.all }),
  getSandboxOptedSecrets: async () => ({ ...store.opted })
}))
const { maskCut, maskDeep, maskList, maskText, sandboxSecretEnv, secretValues, MIN_SANDBOX_SECRET_CHARS } = await import('./secrets')

describe('sandbox secret masking', () => {
  it('M2: an injected (opted-in) value is masked whatever its length; other exec secrets from 6 chars; longest first', () => {
    const v = maskList({ A: 'abcd', B: 'abcdefgh', C: 'xyz12', D: 'hostonly-secret' }, { A: 'abcd', B: 'abcdefgh' })
    expect(v).toEqual(['hostonly-secret', 'abcdefgh', 'abcd'])
    expect(v).not.toContain('xyz12') // not injected, < 6: the host exec rule
  })
  it('M2: longest first, so a value containing another is replaced whole (no leaked tail)', () => {
    const values = maskList({}, { SHORT: 'tok_1234', LONG: 'tok_1234_EXTRA_PART' })
    expect(maskText('a tok_1234_EXTRA_PART b tok_1234', values)).toBe('a «redacted» b «redacted»')
    // the old store-order behaviour would have left "_EXTRA_PART" visible:
    expect(maskText('tok_1234_EXTRA_PART', ['tok_1234', 'tok_1234_EXTRA_PART'])).toBe('«redacted»_EXTRA_PART')
  })
  it('M1: a cut start loses the visible end of a value; a cut end loses the visible start', () => {
    const S = 'sk-live-ABCDEFGH'
    expect(maskCut('LIVE-ABCDEFGH rest sk-live-ABCDEFGH', [S], { start: true })).toBe('LIVE-ABCDEFGH rest «redacted»') // not a suffix: kept
    expect(maskCut('ABCDEFGH rest', [S], { start: true })).toBe(' rest')
    expect(maskCut('rest sk-live-AB', [S], { end: true })).toBe('rest ')
    expect(maskCut('rest sk-live-AB', [S], {})).toBe('rest sk-live-AB') // uncut: nothing trimmed
    expect(maskCut('sk-live-ABCDEFGH', [S], { start: true, end: true })).toBe('«redacted»')
  })
  it('maskDeep walks results; an empty list is a no-op', () => {
    expect(maskDeep({ a: ['x tok_99999'], b: { c: 'tok_99999' }, n: 3 }, ['tok_99999'])).toEqual({ a: ['x «redacted»'], b: { c: '«redacted»' }, n: 3 })
    const o = { a: 'x' }
    expect(maskDeep(o, [])).toBe(o)
  })
  it(`a too-short opted-in value (< ${MIN_SANDBOX_SECRET_CHARS}) is never injected, but still masked; tainted gets nothing`, async () => {
    store.all = { OK_TOKEN: 'long-enough', TINY: 'ab' }
    store.opted = { OK_TOKEN: 'long-enough', TINY: 'ab' }
    expect(await sandboxSecretEnv({ tainted: false })).toEqual({ OK_TOKEN: 'long-enough' })
    expect(await sandboxSecretEnv({ tainted: true })).toEqual({})
    expect(await secretValues()).toEqual(['long-enough', 'ab'])
  })
})

// Cycle 85 fix round 1 (C1): an eval sandbox never gets a secret — this gate holds on its own,
// even if the store below it were to answer inside a world (here it does: it is mocked).
describe('sandboxSecretEnv in an eval world', () => {
  it('returns nothing in a world, the opted-in secrets outside it', async () => {
    const { runInEvalScope } = await import('../eval/context')
    store.opted = { GITHUB_TOKEN: 'ghp_abcdef' }
    try {
      expect(await sandboxSecretEnv({ tainted: false })).toEqual({ GITHUB_TOKEN: 'ghp_abcdef' })
      expect(await runInEvalScope({} as never, () => sandboxSecretEnv({ tainted: false }))).toEqual({})
    } finally { store.opted = {} }
  })
})
