import { describe, it, expect } from 'vitest'
import { buildThreadTranscript } from '@mymind/core/lib/agent/reflect/transcript'

const at = (min: number) => new Date(Date.UTC(2026, 8, 30, 12, min))

describe('buildThreadTranscript', () => {
  it('labels user and assistant turns', () => {
    const t = buildThreadTranscript([
      { id: '1', role: 'user', content: 'what is on today?', createdAt: at(0) },
      { id: '2', role: 'assistant', content: 'Two meetings.', createdAt: at(1) }
    ])
    expect(t).toBe('[user] what is on today?\n[bridget] Two meetings.')
  })

  it('summarises tool calls by name and summary, never their args or results', () => {
    const t = buildThreadTranscript([
      { id: '1', role: 'assistant', content: 'Done.', createdAt: at(0), toolCalls: [
        { callId: 'c1', name: 'search_docs', kind: 'read', args: { query: 'SECRET-ARG' }, result: { hits: ['SECRET-RESULT'] }, summary: 'Searched docs for deploy', textOffset: 0 },
        { name: 'create_task', summary: 'Created task "ship it"' },
        null
      ] }
    ])
    expect(t).toContain('[tool search_docs → Searched docs for deploy]')
    expect(t).toContain('[tool create_task → Created task "ship it"]')
    expect(t).toContain('[bridget] Done.')
    expect(t).not.toContain('SECRET-ARG')
    expect(t).not.toContain('SECRET-RESULT')
  })

  it('excludes reasoning', () => {
    const msg = { id: '1', role: 'assistant', content: 'Answer.', createdAt: at(0), reasoning: 'HIDDEN-THOUGHT' }
    const t = buildThreadTranscript([msg])
    expect(t).toBe('[bridget] Answer.')
    expect(t).not.toContain('HIDDEN-THOUGHT')
  })

  it('cuts the oldest turns first at maxChars', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', content: `turn-${i} ` + 'x'.repeat(40), createdAt: at(i) }))
    const full = buildThreadTranscript(msgs)
    const cut = buildThreadTranscript(msgs, { maxChars: 200 })
    expect(cut.length).toBeLessThanOrEqual(200)
    expect(cut).toContain('turn-9')
    expect(cut).toContain('turn-8')
    expect(cut).not.toContain('turn-0 ')
    expect(full).toContain('turn-0 ')
    expect(cut).toMatch(/^\[… earlier turns omitted\]/)
  })

  it('orders by createdAt even when given out of order', () => {
    const t = buildThreadTranscript([
      { id: '2', role: 'assistant', content: 'second', createdAt: at(2) },
      { id: '1', role: 'user', content: 'first', createdAt: at(1) }
    ])
    expect(t).toBe('[user] first\n[bridget] second')
  })
})
