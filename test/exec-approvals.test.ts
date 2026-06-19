import { describe, it, expect } from 'vitest'
import { matchesApproval, validatePattern, proposedPattern, approvalOutcome } from '../server/lib/exec/approvals'

describe('matchesApproval', () => {
  it('matches a command under an allowed prefix glob', () => {
    expect(matchesApproval('git status', ['git *'])).toBe(true)
    expect(matchesApproval('git log --oneline -5', ['git *'])).toBe(true)
  })
  it('is anchored — does not match a different leading binary', () => {
    expect(matchesApproval('xgit status', ['git *'])).toBe(false)
    expect(matchesApproval('rm -rf /', ['git *'])).toBe(false)
  })
  it('blocks shell chaining inside an approved prefix', () => {
    expect(matchesApproval('git status && rm -rf /', ['git *'])).toBe(false)
    expect(matchesApproval('git status; rm -rf /', ['git *'])).toBe(false)
    expect(matchesApproval('git status | sh', ['git *'])).toBe(false)
    expect(matchesApproval('git $(rm -rf /)', ['git *'])).toBe(false)
  })
  it('matches against any pattern in the list', () => {
    expect(matchesApproval('ls -la', ['git *', 'ls *'])).toBe(true)
  })
  it('ignores invalid / bare-wildcard patterns', () => {
    expect(matchesApproval('echo hi', ['*'])).toBe(false)
    expect(matchesApproval('echo hi', ['   '])).toBe(false)
  })
  it('returns false for an empty allowlist', () => {
    expect(matchesApproval('git status', [])).toBe(false)
  })
  it('treats a literal pattern (no wildcard) as an exact match', () => {
    expect(matchesApproval('ls', ['ls'])).toBe(true)
    expect(matchesApproval('ls -la', ['ls'])).toBe(false)
  })
})

describe('validatePattern', () => {
  it('rejects empty and wildcard-only patterns', () => {
    expect(validatePattern('').valid).toBe(false)
    expect(validatePattern('   ').valid).toBe(false)
    expect(validatePattern('*').valid).toBe(false)
    expect(validatePattern(' * ').valid).toBe(false)
    expect(validatePattern('**').valid).toBe(false)
  })
  it('accepts patterns with a literal command', () => {
    expect(validatePattern('git *').valid).toBe(true)
    expect(validatePattern('ls').valid).toBe(true)
  })
})

describe('proposedPattern', () => {
  it('derives first-token + wildcard', () => {
    expect(proposedPattern('git status -s')).toBe('git *')
    expect(proposedPattern('ls')).toBe('ls *')
    expect(proposedPattern('  npm   run build ')).toBe('npm *')
    expect(proposedPattern('/usr/bin/python3 x.py')).toBe('/usr/bin/python3 *')
  })
  it('returns empty for an empty command', () => {
    expect(proposedPattern('   ')).toBe('')
  })
})

describe('approvalOutcome', () => {
  it('approve without remember does not persist', () => {
    expect(approvalOutcome({ kind: 'approve', proposedPattern: 'git *' }))
      .toEqual({ approved: true, persist: false, pattern: null })
  })
  it('approve+remember persists the proposed pattern', () => {
    expect(approvalOutcome({ kind: 'approve', remember: true, proposedPattern: 'git *' }))
      .toEqual({ approved: true, persist: true, pattern: 'git *' })
  })
  it('approve+remember honours an edited pattern', () => {
    expect(approvalOutcome({ kind: 'approve', remember: true, pattern: 'git log *', proposedPattern: 'git *' }))
      .toEqual({ approved: true, persist: true, pattern: 'git log *' })
  })
  it('deny and timeout never approve or persist', () => {
    expect(approvalOutcome({ kind: 'deny' })).toEqual({ approved: false, persist: false, pattern: null })
    expect(approvalOutcome({ kind: 'timeout' })).toEqual({ approved: false, persist: false, pattern: null })
  })
})
