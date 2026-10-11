// Cycle 81 Task 4 — POST /api/agent/undo across processes: a token minted here is redeemed here; any
// other goes to the worker as an `undo` command, whose real UndoResult comes back. A worker that
// doesn't answer is a visible failure, never a silent success.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ sendCommand: vi.fn() }))
vi.mock('../bus/commands', async importOriginal => ({ ...(await importOriginal<typeof import('../bus/commands')>()), sendCommand: m.sendCommand }))

import { redeemUndo } from './undo-remote'
import { registerUndo, hasUndo } from './undo'
import { CommandFailedError, CommandTimeoutError } from '../bus/commands'

beforeEach(() => { vi.clearAllMocks() })

describe('redeemUndo', () => {
  it('a token minted in THIS process is redeemed here — the worker is never asked', async () => {
    const fn = vi.fn(async () => {})
    const token = registerUndo(fn)
    expect(await redeemUndo(token)).toEqual({ ok: true })
    expect(fn).toHaveBeenCalledOnce()
    expect(hasUndo(token)).toBe(false)
    expect(m.sendCommand).not.toHaveBeenCalled()
  })

  it('any other token is redeemed by the worker, and its real UndoResult comes back', async () => {
    m.sendCommand.mockResolvedValueOnce({ ok: false, reason: 'undo expired or already used' })
    expect(await redeemUndo('worker-token')).toEqual({ ok: false, reason: 'undo expired or already used' })
    expect(m.sendCommand).toHaveBeenCalledWith('undo', { token: 'worker-token' }, { awaitResult: true, timeoutMs: 10_000 })
  })

  it('no answer within the timeout is a failure the user sees — worded by whether the worker picked it up', async () => {
    m.sendCommand.mockRejectedValueOnce(new CommandTimeoutError('undo', 1, 10_000, false))
    expect(await redeemUndo('t1')).toEqual({ ok: false, reason: expect.stringMatching(/did not answer in time, so nothing was undone/) })
    m.sendCommand.mockRejectedValueOnce(new CommandTimeoutError('undo', 2, 10_000, true))
    expect(await redeemUndo('t2')).toEqual({ ok: false, reason: expect.stringMatching(/still working on this undo/) })
  })

  it('a failed command is { ok: false } (its message stays in the log — it may carry a document body)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    m.sendCommand.mockRejectedValueOnce(new CommandFailedError('undo', 3, 'duplicate key value: <document body>'))
    const res = await redeemUndo('t3')
    expect(res).toEqual({ ok: false, reason: 'the undo failed in the agent worker' })
    expect(JSON.stringify(res)).not.toContain('document body')
    err.mockRestore()
  })
})
