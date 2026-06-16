import { describe, it, expect } from 'vitest'
import { buildSummaryTranscript, parseSummary } from '../server/services/session-summarize'

describe('parseSummary', () => {
  it('parses strict JSON', () => {
    expect(parseSummary('{"title":"T","summary":"S"}')).toEqual({ title: 'T', summary: 'S' })
  })
  it('tolerates code fences + surrounding prose', () => {
    expect(parseSummary('here:\n```json\n{"title":"A","summary":"B"}\n```')).toEqual({ title: 'A', summary: 'B' })
  })
  it('caps title to 200 and summary to 4000 chars', () => {
    const r = parseSummary(JSON.stringify({ title: 'x'.repeat(300), summary: 'y'.repeat(5000) }))
    expect(r!.title.length).toBe(200)
    expect(r!.summary.length).toBe(4000)
  })
  it('returns null on unparseable / empty summary', () => {
    expect(parseSummary('not json')).toBeNull()
    expect(parseSummary('{"title":"t","summary":""}')).toBeNull()
  })
})

describe('buildSummaryTranscript', () => {
  it('renders user/assistant text + thinking + tool one-liners, chronological', () => {
    const t = buildSummaryTranscript([
      { role: 'user', content: 'do X', thinking: null },
      { role: 'assistant', content: 'ok', thinking: 'I will do X' }
    ], [{ toolName: 'Bash', exitStatus: 'ok' }])
    expect(t).toContain('do X')
    expect(t).toContain('<thinking>I will do X</thinking>')
    expect(t).toContain('[tool] Bash')
  })
  it('elides the middle when over the char cap', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: 'm'.repeat(2000) + i, thinking: null }))
    const t = buildSummaryTranscript(msgs, [], 5000)
    expect(t).toContain('messages elided')
    expect(t.length).toBeLessThan(8000)
  })
})
