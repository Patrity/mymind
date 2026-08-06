import { describe, it, expect } from 'vitest'
import { buildModelMessages, type AgentMessage } from './run'
import type { AgentToolRecord } from './tool-history'

const rec = (o: Partial<AgentToolRecord> = {}): AgentToolRecord => ({
  callId: 'c1', name: 'web_search', kind: 'read', args: { q: 'x' },
  result: { hits: 1 }, summary: 's', textOffset: 0, ...o
})

describe('buildModelMessages', () => {
  it('expands a tool turn into paired call/result messages plus the text', () => {
    const out = buildModelMessages([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: 'Found it.', toolRecords: [rec()] }
    ]) as { role: string; content: unknown }[]

    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(out.at(-1)!.content).toBe('Found it.')
  })

  it('WIRING: stale results are elided by the time they reach the model', () => {
    const history: AgentMessage[] = []
    for (let i = 0; i < 5; i++) {
      history.push({ role: 'user', content: `q${i}` })
      history.push({ role: 'assistant', content: `a${i}`, toolRecords: [rec({ callId: `c${i}`, result: { big: 'z'.repeat(3000) } })] })
    }
    const out = buildModelMessages(history) as { role: string; content: { output?: { value?: unknown } }[] }[]
    const firstToolMsg = out.find(m => m.role === 'tool')!
    expect(firstToolMsg.content[0]!.output!.value).toEqual({ elided: true, bytes: expect.any(Number) })
  })

  it('IMAGE INVARIANT: no /api/images URL survives into model messages', () => {
    const out = buildModelMessages([
      { role: 'assistant', content: 'here', toolRecords: [rec({ name: 'generate_image', kind: 'create', result: { ok: true, id: 'img1', summary: 'a cat' } })] }
    ])
    expect(JSON.stringify(out)).not.toMatch(/\/api\/images/)
  })

  it('legacy records produce no unpaired tool message', () => {
    const out = buildModelMessages([
      { role: 'assistant', content: 'old turn', toolRecords: [{ name: 'x', summary: 's' } as unknown as AgentToolRecord] }
    ]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['assistant'])
  })

  it('drops system messages, as before', () => {
    const out = buildModelMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['user'])
  })
})
