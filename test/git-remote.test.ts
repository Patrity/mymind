import { describe, it, expect } from 'vitest'
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../server/lib/projects/git-remote'

describe('normalizeGitRemote', () => {
  it('normalizes scp, https, creds, ssh+port, .git, case', () => {
    expect(normalizeGitRemote('git@github.com:Patrity/mymind.git')).toBe('github.com/patrity/mymind')
    expect(normalizeGitRemote('https://github.com/Patrity/mymind.git')).toBe('github.com/patrity/mymind')
    expect(normalizeGitRemote('https://x-access-token:TOK@github.com/Patrity/mymind')).toBe('github.com/patrity/mymind')
    expect(normalizeGitRemote('ssh://git@git.costanzoclan.com:2222/tony/foo.git')).toBe('git.costanzoclan.com/tony/foo')
    expect(normalizeGitRemote('https://github.com/Patrity/mymind/')).toBe('github.com/patrity/mymind')
  })
  it('returns null for empty / unparseable', () => {
    expect(normalizeGitRemote('')).toBeNull()
    expect(normalizeGitRemote(null)).toBeNull()
    expect(normalizeGitRemote(undefined)).toBeNull()
    expect(normalizeGitRemote('not-a-remote')).toBeNull()
  })
})

describe('repoNameFromKey', () => {
  it('takes the last path segment', () => {
    expect(repoNameFromKey('github.com/patrity/mymind')).toBe('mymind')
  })
})

describe('nextUniqueSlug', () => {
  it('returns base when free, else suffixes', () => {
    expect(nextUniqueSlug('mymind', new Set())).toBe('mymind')
    expect(nextUniqueSlug('mymind', new Set(['mymind']))).toBe('mymind-2')
    expect(nextUniqueSlug('mymind', new Set(['mymind', 'mymind-2']))).toBe('mymind-3')
  })
})
