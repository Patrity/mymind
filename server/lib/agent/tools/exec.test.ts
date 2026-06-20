// server/lib/agent/tools/exec.test.ts
// Unit tests for execTool.autoApprove and the catastrophic hard-block in handler.
// These tests do NOT exercise runConstrained (requires a real shell environment);
// they focus on the decision layer added in Task 4.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock DB-bound loadApprovals ----
vi.mock('../../exec/approvals', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../exec/approvals')>()
  return {
    ...real,
    // loadApprovals hits the DB; replace with an in-memory stub
    loadApprovals: vi.fn().mockResolvedValue([]),
  }
})

// ---- mock runConstrained + getDecryptedSecrets so handler tests don't spawn processes ----
vi.mock('../../exec/run', () => ({
  runConstrained: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false }),
  ExecDisabledError: class ExecDisabledError extends Error {},
}))

vi.mock('../../exec/secrets', () => ({
  getDecryptedSecrets: vi.fn().mockResolvedValue({}),
}))

import { execTool } from './exec'
import { loadApprovals } from '../../exec/approvals'
import type { ToolContext } from '../types'

const ctx: ToolContext = { signal: new AbortController().signal }

describe('execTool.autoApprove', () => {
  beforeEach(() => {
    vi.mocked(loadApprovals).mockResolvedValue([])
  })

  it('returns false for unknown commands (no allowlist)', async () => {
    const result = await execTool.autoApprove!({ command: 'apt install jq' }, ctx)
    expect(result).toBe(false)
  })

  it('returns true for a LAN curl without any allowlist entry', async () => {
    const result = await execTool.autoApprove!({ command: 'curl http://192.168.2.25:8004/v1/models' }, ctx)
    expect(result).toBe(true)
  })

  it('returns true when command matches an allowlist pattern', async () => {
    vi.mocked(loadApprovals).mockResolvedValue([
      { id: '1', pattern: 'gh *', tool: 'exec', createdAt: new Date(), lastUsedAt: null },
    ])
    const result = await execTool.autoApprove!({ command: 'gh pr list' }, ctx)
    expect(result).toBe(true)
  })

  it('returns false for catastrophic commands even if they match a wildcard pattern', async () => {
    vi.mocked(loadApprovals).mockResolvedValue([
      { id: '1', pattern: 'rm *', tool: 'exec', createdAt: new Date(), lastUsedAt: null },
    ])
    const result = await execTool.autoApprove!({ command: 'rm -rf /' }, ctx)
    expect(result).toBe(false)
  })

  it('returns false for external unlisted curl', async () => {
    const result = await execTool.autoApprove!({ command: 'curl https://api.github.com/user' }, ctx)
    expect(result).toBe(false)
  })
})

describe('execTool.handler — catastrophic hard-block', () => {
  it('hard-blocks rm -rf / without calling runConstrained', async () => {
    const { runConstrained } = await import('../../exec/run')
    vi.mocked(runConstrained).mockClear()
    const r = await execTool.handler({ command: 'rm -rf /' }, ctx)
    expect(r.result).toMatchObject({ ok: false, blocked: true, error: 'refused: catastrophic command' })
    expect(r.summary).toMatch(/catastrophic/)
    expect(runConstrained).not.toHaveBeenCalled()
  })

  it('hard-blocks mkfs even if somehow autoApproved', async () => {
    const { runConstrained } = await import('../../exec/run')
    vi.mocked(runConstrained).mockClear()
    const r = await execTool.handler({ command: 'mkfs.ext4 /dev/sda' }, ctx)
    expect(r.result).toMatchObject({ ok: false, blocked: true })
    expect(runConstrained).not.toHaveBeenCalled()
  })

  it('runs normal commands through runConstrained', async () => {
    const { runConstrained } = await import('../../exec/run')
    vi.mocked(runConstrained).mockClear()
    const r = await execTool.handler({ command: 'ls /tmp' }, ctx)
    expect(runConstrained).toHaveBeenCalledOnce()
    expect(r.result).toMatchObject({ exitCode: 0 })
  })
})
