// test/agent-runtime-approvals.db.test.ts
//
// The exec allowlist lives in runtime/approvals.ts's approvalFor, not in the socket: a run
// whose originating socket is gone must still auto-approve an allowlisted command, and must
// still deny (never hang) a command that needs a human. Harness per
// test/conversation-epoch.db.test.ts.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq } from 'drizzle-orm'
import { useDb } from '../server/db'
import { execApprovals } from '../server/db/schema'
import { approvalFor, registerApprovalChannel, unregisterApprovalChannel } from '../server/lib/agent/runtime/approvals'

// A tool name no real row uses, so loadApprovals(tool) only ever sees this file's row.
const TOOL = `exec-test-${randomUUID()}`
const createdIds: string[] = []

async function seedPattern(pattern: string, tool = TOOL) {
  const [row] = await useDb().insert(execApprovals).values({ pattern, tool }).returning()
  createdIds.push(row!.id)
  return row!
}

afterAll(async () => {
  for (const id of createdIds) await useDb().delete(execApprovals).where(eq(execApprovals.id, id))
})

// allowlistable: exec's requests carry it (buildAiTools sets it from the tool) — the allowlist is opt-in.
const req = (command: string) => ({ tool: TOOL, command, proposedPattern: 'echo *', allowlistable: true })

describe('approvalFor — allowlist is server-side', () => {
  it('approves an allowlisted command with NO channel registered, and touches the pattern', async () => {
    const row = await seedPattern('echo allowtest *')
    const runId = randomUUID()
    expect(await approvalFor(runId)(req('echo allowtest hello'))).toEqual({ approved: true })
    // touchApproval is fire-and-forget; give it a moment to land.
    await new Promise(r => setTimeout(r, 200))
    const [after] = await useDb().select().from(execApprovals).where(eq(execApprovals.id, row.id))
    expect(after!.lastUsedAt).not.toBeNull()
  })

  it('denies a non-allowlisted command with NO channel registered', async () => {
    expect(await approvalFor(randomUUID())(req('rm -rf /tmp/nope'))).toEqual({ approved: false })
  })

  it('does not ask the channel for an allowlisted command', async () => {
    await seedPattern('echo chan *')
    const runId = randomUUID()
    const ch = vi.fn(async () => ({ approved: false }))
    registerApprovalChannel(runId, ch)
    try {
      expect(await approvalFor(runId)(req('echo chan x'))).toEqual({ approved: true })
      expect(ch).not.toHaveBeenCalled()
    } finally { unregisterApprovalChannel(runId) }
  })

  it('ignores a saved pattern for a tool that is not allowlistable (decide_review): still asks', async () => {
    // A pattern that would match, saved for decide_review (e.g. via a crafted "always allow").
    await seedPattern('approve *', 'decide_review')
    const runId = randomUUID()
    const ch = vi.fn(async () => ({ approved: false }))
    registerApprovalChannel(runId, ch)
    try {
      const decide = { tool: 'decide_review', command: 'approve — some item', proposedPattern: '', allowlistable: false }
      expect(await approvalFor(runId)(decide)).toEqual({ approved: false })
      // No flag at all is treated the same as false.
      const { allowlistable: _a, ...noFlag } = decide
      expect(await approvalFor(runId)(noFlag)).toEqual({ approved: false })
      expect(ch).toHaveBeenCalledTimes(2)
    } finally { unregisterApprovalChannel(runId) }
    // …and with no channel at all it is denied, never auto-approved.
    expect(await approvalFor(randomUUID())({ tool: 'decide_review', command: 'approve — x', proposedPattern: '' })).toEqual({ approved: false })
  })

  it('asks the channel for a non-allowlisted command', async () => {
    const runId = randomUUID()
    const ch = vi.fn(async () => ({ approved: true }))
    registerApprovalChannel(runId, ch)
    try {
      expect(await approvalFor(runId)(req('ls -la'))).toEqual({ approved: true })
      expect(ch).toHaveBeenCalledOnce()
    } finally { unregisterApprovalChannel(runId) }
  })
})
