// test/summarize-threads-task.test.ts
//
// Cycle 74 review fix (Task 7 round 1): this case was carried over from the deleted
// agent-runtime-flag-gate.test.ts, minus the agent_runtime flag mock — nothing else asserts
// that the summarize-threads task is actually wired to summarizeIdleThreads.
import { describe, it, expect, vi, afterEach } from 'vitest'

const m = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ summarized: 0, failed: 0 })) }))
vi.mock('@mymind/core/lib/agent/runtime/summarize', () => ({ summarizeIdleThreads: m.sweep }))

// Cycle 81: the task moved from server/tasks to core's agent schedule (run by the executing process).
import { summarizeThreadsTask as task } from '@mymind/core/lib/agent/scheduled'

const run = (task as unknown as { run: () => Promise<{ result: Record<string, unknown> }> }).run

afterEach(() => { vi.clearAllMocks() })

describe('summarize-threads task', () => {
  it('calls summarizeIdleThreads once and forwards its result', async () => {
    m.sweep.mockResolvedValueOnce({ summarized: 3, failed: 1 })
    const out = await run()
    expect(m.sweep).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ result: { summarized: 3, failed: 1 } })
  })
})
