import { describe, it, expect } from 'vitest'
import { withFailoverOver } from '../server/lib/ai/registry/resolve'
import type { ResolvedModel } from '../server/lib/ai/registry/types'
import type { SpanInput } from '../server/lib/observability/types'

const chain: ResolvedModel[] = [
  { usage: 'reasoning', modelDefId: 'm1', providerKind: 'openai-compatible', baseURL: 'http://a', apiKey: 'k', modelId: 'broken', label: 'Broken', dim: null },
  { usage: 'reasoning', modelDefId: 'm2', providerKind: 'openai-compatible', baseURL: 'http://b', apiKey: 'k', modelId: 'good', label: 'Good', dim: null }
]

/** Exactly what node/undici `fetch` throws when its AbortSignal fires. */
function abortError(): Error {
  const e = new Error('This operation was aborted')
  e.name = 'AbortError'
  return e
}

describe('withFailoverOver instrumentation', () => {
  it('records one attempt row per model tried, with statuses, via the injected recorder', async () => {
    const events: SpanInput[] = []
    const obs = { recordEvent: (e: SpanInput) => events.push(e) }
    const out = await withFailoverOver('reasoning', chain, async (m) => {
      if (m.modelId === 'broken') throw new Error('no usable content')
      return 'real answer'
    }, obs)
    expect(out).toBe('real answer')
    const attempts = events.filter(e => e.kind === 'attempt')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.status).toBe('error')
    expect(attempts[0]!.attempt).toBe(0)
    expect((attempts[0]!.error as { message: string }).message).toBe('no usable content')
    expect(attempts[1]!.status).toBe('ok')
    expect(attempts[1]!.attempt).toBe(1)
    // provider is host-only, never the apiKey
    expect(JSON.stringify(events)).not.toContain('"k"')
  })
})

// A cancelled call is not a provider failure: the caller walked away. Recording it as
// one turned every barge-in/VAD re-segmentation of a voice turn into 2 unacked prod
// errors + a bogus "all models failed" toast (prod, 2026-08-05 00:41 UTC — 6 cancelled
// STT turns => 12 error rows).
describe('withFailoverOver cancellation', () => {
  it('records a cancelled attempt as warn/info, not as an error, and emits no all-failed row', async () => {
    const events: SpanInput[] = []
    const obs = { recordEvent: (e: SpanInput) => events.push(e) }
    await expect(withFailoverOver('stt', chain, async () => { throw abortError() }, obs))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'attempt', status: 'warn', severity: 'info' })
    expect(events.some(e => e.name.endsWith(':all-failed'))).toBe(false)
    // the badge counts status==='error'; a cancellation must not reach it
    expect(events.filter(e => e.status === 'error')).toHaveLength(0)
  })

  it('stops the chain on cancellation instead of burning the remaining providers', async () => {
    const tried: string[] = []
    await expect(withFailoverOver('stt', chain, async (m) => { tried.push(m.modelId); throw abortError() },
      { recordEvent: () => {} })).rejects.toMatchObject({ name: 'AbortError' })
    expect(tried).toEqual(['broken'])   // never dialled 'good' with a dead signal
  })

  it('rethrows the ORIGINAL abort so upstream `err.name === AbortError` guards still fire', async () => {
    // Regression: wrapping the abort in AiAllFailedError made handleUtterance (orchestrator.ts)
    // and run() (ws.ts) miss their abort guards, so a cancelled turn shipped an error frame
    // to the client and logged "[agent] turn failed".
    const err = await withFailoverOver('stt', chain, async () => { throw abortError() },
      { recordEvent: () => {} }).catch((e: Error) => e)
    expect(err.name).toBe('AbortError')
  })

  it('still treats a real provider failure as an error (cancellation check must not swallow those)', async () => {
    const events: SpanInput[] = []
    await expect(withFailoverOver('stt', chain, async () => { throw new Error('connect ECONNREFUSED') },
      { recordEvent: (e: SpanInput) => events.push(e) })).rejects.toMatchObject({ name: 'AiAllFailedError' })
    expect(events.filter(e => e.kind === 'attempt' && e.status === 'error')).toHaveLength(2)
    expect(events.some(e => e.name.endsWith(':all-failed') && e.status === 'error')).toBe(true)
  })
})
