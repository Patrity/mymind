import { describe, it, expect } from 'vitest'
import { execAutoApproveDecision } from './approvals'

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
