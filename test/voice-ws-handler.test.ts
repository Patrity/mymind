// test/voice-ws-handler.test.ts
//
// The runtime socket (server/api/voice/ws.ts) driven with a fake peer. The runtime itself is
// mocked — these tests pin what the SOCKET does with frames: which thread it enqueues into,
// what it subscribes to, what Stop aborts, which approvals Stop denies.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted: the handler module calls this Nitro auto-import at import time.
vi.hoisted(() => { (globalThis as Record<string, unknown>).defineWebSocketHandler = (h: unknown) => h })

const m = vi.hoisted(() => ({
  enqueue: vi.fn(),
  abortActive: vi.fn(async () => true),
  abortActiveAndWait: vi.fn(async () => true),
  abortRun: vi.fn(),
  registerApprovalChannel: vi.fn(),
  unregisterApprovalChannel: vi.fn(),
  hasApprovalChannel: vi.fn(() => true),
  transcribe: vi.fn(async () => 'spoken words'),
  clear: vi.fn(async () => {}),
  order: [] as string[]
}))
vi.mock('../server/lib/voice/ws-legacy', () => ({ legacyHooks: {} }))
vi.mock('../server/lib/agent/runtime/flag', () => ({ runtimeEnabled: () => true }))
vi.mock('../server/lib/agent/runtime/queue', () => ({ enqueue: m.enqueue, abortActive: m.abortActive, abortActiveAndWait: m.abortActiveAndWait }))
vi.mock('../server/lib/agent/runtime/aborts', () => ({ abortRun: m.abortRun }))
vi.mock('../server/lib/agent/runtime/approvals', () => ({
  registerApprovalChannel: m.registerApprovalChannel, unregisterApprovalChannel: m.unregisterApprovalChannel,
  hasApprovalChannel: m.hasApprovalChannel, turnStreamFor: () => undefined
}))
vi.mock('../server/lib/ai/registry/resolve', () => ({ withFailover: (_u: string, fn: (x: unknown) => unknown) => fn({}) }))
vi.mock('../server/lib/voice/providers', () => ({ sttFromModel: () => ({ transcribe: m.transcribe }) }))
vi.mock('../server/services/conversation-clear', () => ({ clearConversationContext: m.clear }))
vi.mock('../server/db', () => ({ useDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ at: new Date(0) }] }) }) }) }) }))
vi.mock('../server/lib/observability/record', () => ({ recordEvent: vi.fn() }))

import handler from '../server/api/voice/ws'
import { hub } from '../server/lib/agent/runtime/stream'

type H = { open: (p: unknown) => void; message: (p: unknown, msg: unknown) => Promise<void>; close: (p: unknown) => void }
const h = handler as unknown as H

function peer() {
  const sent: string[] = []
  return { sent, send: (d: string | Uint8Array) => { if (typeof d === 'string') sent.push(d) } }
}
const frame = (o: Record<string, unknown>) => ({ rawData: JSON.stringify(o), uint8Array: () => new Uint8Array() })
const wav = () => { const b = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]); return { rawData: b, uint8Array: () => b } }
const sessionKeys = () => m.enqueue.mock.calls.map(c => (c[0] as { sessionKey: string }).sessionKey)
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const result = (runId: string, conversationId: string, steered = false) => ({ runId, conversationId, steered, created: false })
/** Let the submit's lock callback run, so its enqueue is genuinely awaiting. */
const inFlight = async () => { await new Promise(r => setTimeout(r, 5)); expect(m.enqueue).toHaveBeenCalledTimes(1) }
const types = (p: { sent: string[] }) => p.sent.map(s => JSON.parse(s) as { type: string; [k: string]: unknown })

beforeEach(() => {
  vi.clearAllMocks()
  m.hasApprovalChannel.mockReturnValue(true)
})

describe('ws runtime socket', () => {
  it('two back-to-back submits on a new thread land in ONE thread (enqueue is serialised)', async () => {
    const p = peer(); h.open(p)
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise).mockImplementation(async (req: { sessionKey: string }) => result('r2', req.sessionKey.slice(7)))
    const a = h.message(p, frame({ type: 'text', text: 'one' }))
    const b = h.message(p, frame({ type: 'text', text: 'two' }))
    await new Promise(r => setTimeout(r, 10))
    first.resolve(result('r1', 'c1'))
    await Promise.all([a, b])
    expect(sessionKeys()).toEqual(['thread:new', 'thread:c1'])
  })

  it('a load during an in-flight enqueue is not undone when the enqueue returns', async () => {
    const p = peer(); h.open(p)
    const sub = vi.spyOn(hub, 'subscribe')
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise).mockImplementation(async (req: { sessionKey: string }) => result('r2', req.sessionKey.slice(7)))
    const a = h.message(p, frame({ type: 'text', text: 'one' }))
    await inFlight()
    await h.message(p, frame({ type: 'load', conversationId: 'c2' }))
    first.resolve(result('r1', 'cNew'))
    await a
    expect(sub.mock.calls.map(c => c[0])).not.toContain('cNew')
    await h.message(p, frame({ type: 'text', text: 'three' }))
    expect(sessionKeys()[1]).toBe('thread:c2')
    sub.mockRestore()
  })

  it('a `new` during an in-flight new-thread enqueue is not undone either', async () => {
    const p = peer(); h.open(p)
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise).mockImplementation(async () => result('r2', 'cOther'))
    const a = h.message(p, frame({ type: 'text', text: 'one' }))
    await inFlight()
    await h.message(p, frame({ type: 'new' }))
    first.resolve(result('r1', 'cNew'))
    await a
    await h.message(p, frame({ type: 'text', text: 'two' }))
    expect(sessionKeys()).toEqual(['thread:new', 'thread:new'])
  })

  it('load does not subscribe; attach subscribes + replays in one step', async () => {
    const p = peer(); h.open(p)
    const sub = vi.spyOn(hub, 'subscribe')
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    expect(sub).not.toHaveBeenCalled()
    await h.message(p, frame({ type: 'attach' }))
    expect(sub).toHaveBeenCalledOnce()
    expect(sub.mock.calls[0]![0]).toBe('c1')
    expect(sub.mock.calls[0]![2]).toEqual({ replay: true })
    sub.mockRestore()
  })

  it('Stop denies only the approvals of the thread in view', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async (req: { sessionKey: string }) => result(`run-${req.sessionKey}`, req.sessionKey.slice(7)))
    await h.message(p, frame({ type: 'load', conversationId: 'cA' }))
    await h.message(p, frame({ type: 'text', text: 'a' }))
    await h.message(p, frame({ type: 'load', conversationId: 'cB' }))
    await h.message(p, frame({ type: 'text', text: 'b' }))
    const [chA, chB] = m.registerApprovalChannel.mock.calls.map(c => c[1] as (r: unknown) => Promise<{ approved: boolean }>)
    const req = { tool: 'exec', command: 'ls', proposedPattern: 'ls *' }
    let aDone = false
    const pa = chA!(req).then((v) => { aDone = true; return v })
    const pb = chB!(req)
    const [idA, idB] = types(p).filter(f => f.type === 'approval').map(f => f.requestId)
    await h.message(p, frame({ type: 'interrupt' }))
    expect(await pb).toEqual({ approved: false })
    const resolved = types(p).filter(f => f.type === 'approval-resolved').map(f => f.requestId)
    expect(resolved).toEqual([idB])
    await new Promise(r => setTimeout(r, 5))
    expect(aDone).toBe(false)
    await h.message(p, frame({ type: 'deny', requestId: idA }))
    expect(await pa).toEqual({ approved: false })
  })

  it('Stop aborts this socket\'s last queued run on the viewed thread', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rQ', 'c1'))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'text', text: 'queued behind something' }))
    await h.message(p, frame({ type: 'interrupt' }))
    expect(m.abortRun).toHaveBeenCalledWith('rQ')
    expect(m.abortActive).toHaveBeenCalledWith('c1')
  })

  it('Stop during an in-flight new-thread enqueue aborts the run that enqueue creates', async () => {
    const p = peer(); h.open(p)
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise)
    const a = h.message(p, frame({ type: 'text', text: 'go' }))
    await inFlight()
    await h.message(p, frame({ type: 'interrupt' }))
    expect(m.abortRun).not.toHaveBeenCalled()
    first.resolve(result('rNew', 'cNew'))
    await a
    expect(m.abortRun).toHaveBeenCalledWith('rNew')
  })

  it('a steered voice utterance returns the client to idle', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rRun', 'c1', true))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, wav())
    const t = types(p).map(f => f.type === 'state' ? `state:${f.state}` : f.type)
    expect(t).toEqual(['state:thinking', 'steered', 'state:idle'])
  })

  it('clear waits for the aborted run to unwind BEFORE writing the epoch', async () => {
    const p = peer(); h.open(p)
    const unwound = deferred<boolean>()
    m.abortActiveAndWait.mockImplementationOnce(async () => { const v = await unwound.promise; m.order.push('unwound'); return v })
    m.clear.mockImplementationOnce(async () => { m.order.push('epoch') })
    m.order.length = 0
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    const c = h.message(p, frame({ type: 'clear' }))
    await new Promise(r => setTimeout(r, 5))
    expect(m.clear).not.toHaveBeenCalled()
    unwound.resolve(true)
    await c
    expect(m.order).toEqual(['unwound', 'epoch'])
    expect(m.abortActiveAndWait).toHaveBeenCalledWith('c1')
  })

  it('clear releases the thread\'s pending approval BEFORE waiting, so a parked run can unwind', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rA', 'c1'))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'text', text: 'run a command' }))
    const ch = m.registerApprovalChannel.mock.calls[0]![1] as (r: unknown) => Promise<{ approved: boolean }>
    // The run is parked on this approval: the exec tool does not race the abort signal, so it
    // only unwinds (and rescues) once the approval resolves.
    const parked = ch({ tool: 'exec', command: 'ls', proposedPattern: 'ls *' })
    m.order.length = 0
    m.abortActiveAndWait.mockImplementationOnce(async () => {
      const unwound = await Promise.race([parked.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 200))])
      m.order.push(unwound ? 'unwound' : 'timed-out')
      return true
    })
    m.clear.mockImplementationOnce(async () => { m.order.push('epoch') })
    const t0 = Date.now()
    await h.message(p, frame({ type: 'clear' }))
    expect(m.order).toEqual(['unwound', 'epoch'])
    expect(Date.now() - t0).toBeLessThan(150)
    expect(await parked).toEqual({ approved: false })
  })

  it('close drops the approval channels of runs it still holds', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rX', 'c1'))
    await h.message(p, frame({ type: 'text', text: 'x' }))
    h.close(p)
    expect(m.unregisterApprovalChannel).toHaveBeenCalledWith('rX')
  })
})
