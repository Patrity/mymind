// Cycle 82 fix round 1 (M3): in the web (remote mode) readWorkspaceText hands its taint to the worker.
import { afterEach, describe, expect, it, vi } from 'vitest'
const sent: unknown[] = []
vi.mock('../bus/commands', () => ({ sendCommand: vi.fn(async (_t: string, p: unknown, o: unknown) => { sent.push([p, o]); return { content: 'x', bytes: 1, path: '/Users/bridget/mymind/workspaces/x/a', tainted: true } }) }))
import { readWorkspaceText } from './runtime'
import { setExecutionMode } from '../agent/runtime/execution-mode'

afterEach(() => { setExecutionMode('local'); sent.length = 0 })

describe('readWorkspaceText in the web', () => {
  it('carries the taint in the worker command (never a silent networked read)', async () => {
    setExecutionMode('remote')
    const ws = '11111111-1111-4111-8111-111111111111'
    expect((await readWorkspaceText(ws, 'a', { tainted: true })).tainted).toBe(true)
    await readWorkspaceText(ws, 'a')
    expect(sent.map(s => (s as unknown[])[0])).toEqual([{ workspaceId: ws, path: 'a', tainted: true }, { workspaceId: ws, path: 'a' }])
  })
})

describe('final review I2: the manager hooks', async () => {
  const { runtimeHooks } = await import('./runtime')
  it('only an armed watch keeps a workspace\'s shells up past its idle time (a running shell does not)', async () => {
    const killed: Array<[string, string]> = []
    let watches = false
    const h = runtimeHooks({
      shells: { hasRunning: async () => true, killAll: async (id: string, why: string) => { killed.push([id, why]); return 1 }, refresh: async () => 0 },
      watches: { hasArmed: async () => watches, cancelFor: async () => 0 }
    } as never)
    expect(await h.isBusy('w')).toBe(false) // a live shell does NOT pin it
    watches = true
    expect(await h.isBusy('w')).toBe(true)
    await h.onStopped('w', 'stopped: idle')
    expect(killed).toEqual([['w', 'stopped: idle']])
    expect(Object.keys(h).sort()).toEqual(['isBusy', 'onStopped', 'onTainted', 'refresh'])
  })
})

describe('follow-up 2 (NB4): quarantineRunWorkspace', async () => {
  const { quarantineRunWorkspace, setWorkspaceRuntime, UNVERIFIED_REASON } = await import('./runtime')
  it('confinement on: stops the run\'s workspace shells and cancels its watches — and never marks the workspace; off: touches nothing', async () => {
    const killed: Array<[string, string]> = []
    const cancelled: Array<[string, string]> = []
    const markTainted = vi.fn()
    let reason: string | null = 'unverified'
    const confinementFor = vi.fn(async () => reason)
    setWorkspaceRuntime({
      resolve: async (runId: string | undefined) => ({ workspaceId: `ws-of-${runId}`, kind: 'workstream', workstreamId: 'w', conversationId: 'c' }),
      shells: { killAll: async (id: string, why: string) => { killed.push([id, why]); return 1 } },
      watches: { cancelFor: async (id: string, why: string) => { cancelled.push([id, why]); return 1 } },
      manager: { markTainted, confinementFor }
    } as never)
    try {
      await quarantineRunWorkspace('run-9')
      expect(confinementFor).toHaveBeenCalledWith('ws-of-run-9', { offline: true })
      expect(killed).toEqual([['ws-of-run-9', `stopped: ${UNVERIFIED_REASON}`]])
      expect(cancelled).toEqual([['ws-of-run-9', UNVERIFIED_REASON]])
      expect(markTainted).not.toHaveBeenCalled()
      reason = null // the switch is off: nothing is stopped
      await quarantineRunWorkspace('run-10')
      expect(killed).toHaveLength(1)
      expect(cancelled).toHaveLength(1)
    } finally { setWorkspaceRuntime(null) }
  })
})
