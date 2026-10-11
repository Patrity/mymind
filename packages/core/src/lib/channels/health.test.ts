// Cycle 81 Task 2 review M2: the iMessage catch-up health lives in the executing process. In remote
// mode (the web) the web reads the worker's heartbeat status and routes forced
// checks / resets to the worker; in local mode it uses its own in-memory state (unchanged).
import { afterEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  sendCommand: vi.fn(), workerStatus: vi.fn(),
  catchUpTick: vi.fn(async () => ({ processed: 0, healthy: true })), lastHealth: vi.fn(), resetHealth: vi.fn()
}))
vi.mock('../bus/commands', () => ({ sendCommand: m.sendCommand, workerStatus: m.workerStatus }))
vi.mock('./inbound', () => ({ catchUpTick: m.catchUpTick, lastHealth: m.lastHealth, resetHealth: m.resetHealth }))

import { checkImessageHealth, currentImessageHealth, IMESSAGE_CHECK_TIMEOUT_MS, resetImessageHealth } from './health'
import { setExecutionMode } from '../agent/runtime/execution-mode'

const LOCAL = { ok: true, privateApi: true, checkedAt: 1 }
const WORKER = { ok: false, privateApi: null, checkedAt: 2, error: 'BlueBubbles down' }

afterEach(() => { setExecutionMode('local'); vi.clearAllMocks() })

describe('local mode (the executing process)', () => {
  it('reads, checks and resets this process\'s own state; never talks to a worker', async () => {
    m.lastHealth.mockReturnValue(LOCAL)
    expect(await currentImessageHealth()).toEqual(LOCAL)
    expect(await checkImessageHealth()).toEqual(LOCAL)
    expect(m.catchUpTick).toHaveBeenCalledWith({ force: true })
    await resetImessageHealth()
    expect(m.resetHealth).toHaveBeenCalledOnce()
    expect(m.sendCommand).not.toHaveBeenCalled()
    expect(m.workerStatus).not.toHaveBeenCalled()
  })
})

describe('remote mode (the web)', () => {
  it('health = what the worker published with its latest heartbeat', async () => {
    setExecutionMode('remote')
    m.workerStatus.mockResolvedValue({ online: true, status: { imessage: WORKER } })
    expect(await currentImessageHealth()).toEqual(WORKER)
    expect(m.lastHealth).not.toHaveBeenCalled()
  })

  it('an offline worker reads as unknown with a reason, not as a stale green', async () => {
    setExecutionMode('remote')
    m.workerStatus.mockResolvedValue({ online: false, status: { imessage: LOCAL } })
    expect(await currentImessageHealth()).toEqual({ ok: false, privateApi: null, checkedAt: null, error: 'the agent worker is offline' })
  })

  it('a forced check runs in the worker (command), never a second catch-up here', async () => {
    setExecutionMode('remote')
    m.sendCommand.mockResolvedValue(WORKER)
    expect(await checkImessageHealth()).toEqual(WORKER)
    expect(m.sendCommand).toHaveBeenCalledWith('imessage-health', { action: 'check' }, { awaitResult: true, timeoutMs: IMESSAGE_CHECK_TIMEOUT_MS })
    expect(m.catchUpTick).not.toHaveBeenCalled()
  })

  it('a reset is sent to the worker', async () => {
    setExecutionMode('remote')
    m.sendCommand.mockResolvedValue(undefined)
    await resetImessageHealth()
    expect(m.sendCommand).toHaveBeenCalledWith('imessage-health', { action: 'reset' })
    expect(m.resetHealth).not.toHaveBeenCalled()
  })
})
