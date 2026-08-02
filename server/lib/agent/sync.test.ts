import { describe, it, expect } from 'vitest'
import { decideSync, hashBody } from './sync'

const H_LOCAL = hashBody('local body')
const H_SERVER = hashBody('server body')
const target = (contentHash: string | null) => ({ id: 'doc-1', contentHash })

describe('hashBody', () => {
  it('is sha256 hex of the body', () => {
    expect(hashBody('hello world')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })
})

describe('decideSync', () => {
  it('creates when nothing matches the path', () => {
    expect(decideSync({}, H_LOCAL, null)).toEqual({ kind: 'create' })
  })

  it('errors when an explicit id resolves to nothing', () => {
    expect(decideSync({ id: 'doc-1' }, H_LOCAL, null)).toEqual({ kind: 'error', error: 'not_found' })
  })

  it('adopts a path match whose content already agrees', () => {
    expect(decideSync({}, H_LOCAL, target(H_LOCAL))).toEqual({ kind: 'adopt', id: 'doc-1' })
  })

  it('reports unchanged when an id-addressed doc already agrees', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: H_LOCAL }, H_LOCAL, target(H_LOCAL)))
      .toEqual({ kind: 'unchanged', id: 'doc-1' })
  })

  it('writes under CAS when expected_hash matches the server', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: H_SERVER }, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'write', id: 'doc-1', expected: H_SERVER })
  })

  it('refuses an id-addressed write with no expected_hash', () => {
    expect(decideSync({ id: 'doc-1' }, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'error', error: 'expected_hash_required' })
  })

  it('refuses to adopt a divergent path match', () => {
    expect(decideSync({}, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'error', error: 'adopt_conflict' })
  })

  it('reports hash_mismatch when expected_hash is stale', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: 'stale' }, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'error', error: 'hash_mismatch' })
  })

  it('force overrides every divergence case', () => {
    const forced = { kind: 'write', id: 'doc-1', expected: null }
    expect(decideSync({ id: 'doc-1', force: true }, H_LOCAL, target(H_SERVER))).toEqual(forced)
    expect(decideSync({ force: true }, H_LOCAL, target(H_SERVER))).toEqual(forced)
    expect(decideSync({ id: 'doc-1', expectedHash: 'stale', force: true }, H_LOCAL, target(H_SERVER))).toEqual(forced)
  })

  it('prefers unchanged over force — a no-op write is still a no-op', () => {
    expect(decideSync({ id: 'doc-1', force: true }, H_LOCAL, target(H_LOCAL)))
      .toEqual({ kind: 'unchanged', id: 'doc-1' })
  })

  it('treats a null stored hash as divergent rather than equal', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: H_SERVER }, H_LOCAL, target(null)))
      .toEqual({ kind: 'error', error: 'hash_mismatch' })
  })
})
