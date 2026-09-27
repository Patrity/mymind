// test/agent-runtime-flag-gate.test.ts
//
// Final review m1: agent_runtime=false must mean the legacy path END TO END — nothing is queued
// or woken beside the in-socket turns (mixed mode), and the runtime's summary sweep stays off.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.hoisted(() => { (globalThis as Record<string, unknown>).defineTask = (t: unknown) => t })
const m = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ summarized: 0, failed: 0 })), resolveSession: vi.fn() }))
vi.mock('../server/lib/agent/runtime/summarize', () => ({ summarizeIdleThreads: m.sweep }))
vi.mock('../server/lib/agent/runtime/sessions', () => ({ resolveSession: m.resolveSession }))

import { setRuntimeEnabledForTest, RuntimeDisabledError } from '../server/lib/agent/runtime/flag'
import { enqueue } from '../server/lib/agent/runtime/queue'
import { wake } from '../server/lib/agent/runtime/wake'
import task from '../server/tasks/summarize-threads'

const run = (task as unknown as { run: () => Promise<unknown> }).run

afterEach(() => { setRuntimeEnabledForTest(true); vi.clearAllMocks() })

describe('agent_runtime=false', () => {
  it('wake() refuses with RuntimeDisabledError before touching anything', async () => {
    setRuntimeEnabledForTest(false)
    await expect(wake({ reason: 'manual', prompt: 'hi' }, { kick: false })).rejects.toBeInstanceOf(RuntimeDisabledError)
    expect(m.resolveSession).not.toHaveBeenCalled()
    // Its own check, first: the disabled mode is the answer even for a malformed request.
    await expect(wake({ reason: '', prompt: '' }, { kick: false })).rejects.toBeInstanceOf(RuntimeDisabledError)
  })

  it('enqueue() refuses too, so nothing can queue beside the legacy socket', async () => {
    setRuntimeEnabledForTest(false)
    await expect(enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'x', modality: 'text' } }, { kick: false }))
      .rejects.toBeInstanceOf(RuntimeDisabledError)
    expect(m.resolveSession).not.toHaveBeenCalled()
  })

  it('the summarize-threads task skips the sweep', async () => {
    setRuntimeEnabledForTest(false)
    await run()
    expect(m.sweep).not.toHaveBeenCalled()
  })

  it('with the flag on, the task does sweep', async () => {
    await run()
    expect(m.sweep).toHaveBeenCalledTimes(1)
  })
})
