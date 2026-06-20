import { describe, it, expect } from 'vitest'
import { execAutoApproveDecision, proposedPattern, validatePattern, matchesApproval } from './approvals'

describe('proposedPattern — host-scoped outbound', () => {
  it('returns a host-scoped pattern for an external curl', () => {
    const p = proposedPattern('curl -s https://api.github.com/zen')
    // Must carry the host, not be bare `curl *`
    expect(p).toContain('https://api.github.com')
    expect(p).not.toBe('curl *')
  })

  it('proposed pattern MATCHES the exact command', () => {
    const p = proposedPattern('curl -s https://api.github.com/zen')
    expect(matchesApproval('curl -s https://api.github.com/zen', [p])).toBe(true)
  })

  it('proposed pattern MATCHES another path on the same host', () => {
    const p = proposedPattern('curl -s https://api.github.com/zen')
    expect(matchesApproval('curl https://api.github.com/other', [p])).toBe(true)
  })

  it('proposed pattern does NOT match a different host', () => {
    const p = proposedPattern('curl -s https://api.github.com/zen')
    expect(matchesApproval('curl https://evil.com/', [p])).toBe(false)
  })

  it('proposed pattern does NOT match a suffix-domain look-alike (api.github.com.evil.com)', () => {
    const p = proposedPattern('curl -s https://api.github.com/zen')
    expect(matchesApproval('curl https://api.github.com.evil.com/', [p])).toBe(false)
  })

  it('LAN curl proposed pattern is unaffected (keeps generic <tool> *)', () => {
    const p = proposedPattern('curl http://192.168.2.25:8004/v1/models')
    // LAN is not external; keeps simple form
    expect(p).toBe('curl *')
  })

  it('non-outbound command proposed pattern is unaffected', () => {
    const p = proposedPattern('gh pr list')
    expect(p).toBe('gh *')
  })
})

describe('validatePattern — bare outbound wildcard rejection', () => {
  it('rejects curl *', () => {
    expect(validatePattern('curl *').valid).toBe(false)
  })

  it('rejects wget *', () => {
    expect(validatePattern('wget *').valid).toBe(false)
  })

  it('accepts a host-scoped curl pattern', () => {
    expect(validatePattern('curl *https://api.github.com/*').valid).toBe(true)
  })

  it('still accepts non-outbound wildcard patterns', () => {
    expect(validatePattern('gh *').valid).toBe(true)
    expect(validatePattern('ls *').valid).toBe(true)
  })
})

describe('execAutoApproveDecision', () => {
  it('LAN curl runs silently with no allowlist entry', () =>
    expect(execAutoApproveDecision({ command: 'curl http://192.168.2.25:8004/v1/models', patterns: [] }).allow).toBe(true))
  it('external curl prompts unless host-allowlisted', () => {
    expect(execAutoApproveDecision({ command: 'curl https://api.github.com/user', patterns: [] }).allow).toBe(false)
    expect(execAutoApproveDecision({ command: 'curl https://api.github.com/user', patterns: ['curl https://api.github.com/*'] }).allow).toBe(true)
  })
  it('allowlisted non-network command runs silently', () =>
    expect(execAutoApproveDecision({ command: 'gh pr list', patterns: ['gh *'] }).allow).toBe(true))
  it('unknown command prompts', () =>
    expect(execAutoApproveDecision({ command: 'apt install jq', patterns: [] }).allow).toBe(false))
  it('catastrophic never auto-allows', () =>
    expect(execAutoApproveDecision({ command: 'rm -rf /', patterns: ['rm *'] }).allow).toBe(false))
})
