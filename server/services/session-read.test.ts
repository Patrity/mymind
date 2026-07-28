import { describe, it, expect } from 'vitest'
import { truncate, snippetAround, mapMessage, mapTool, interleave, CONTENT_CAP, TOOL_CAP } from './session-read'

const at = (ms: number) => new Date(1_700_000_000_000 + ms)

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hi', 10)).toEqual({ text: 'hi' })
  })
  it('caps long strings and reports omitted chars', () => {
    const r = truncate('x'.repeat(50), 20)
    expect(r.text).toBe('x'.repeat(20))
    expect(r.truncated).toBe(30)
  })
})

describe('snippetAround', () => {
  it('centers the window on the first case-insensitive match, eliding both sides', () => {
    const content = 'aaaa NAVMESH bbbb'.padStart(400, 'a').padEnd(800, 'b')
    const s = snippetAround(content, 'navmesh', 10)
    expect(s.toLowerCase()).toContain('navmesh')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
  it('falls back to the head when there is no literal match', () => {
    expect(snippetAround('hello world', 'zzz', 4)).toBe('hello wor…'.slice(0, 8) + '…')
  })
  it('handles empty query by returning the head', () => {
    expect(snippetAround('hello', '', 100)).toBe('hello')
  })
})

describe('mapMessage', () => {
  const row = { id: 'm1', role: 'assistant', content: 'y'.repeat(CONTENT_CAP + 100), thinking: 'secret', createdAt: at(0) }
  it('truncates content and drops thinking by default', () => {
    const item = mapMessage(row, false)
    expect(item.kind).toBe('message')
    expect(item.content.length).toBe(CONTENT_CAP)
    expect(item.truncated).toBe(100)
    expect(item.thinking).toBeUndefined()
  })
  it('includes full content + thinking when full', () => {
    const item = mapMessage(row, true)
    expect(item.content.length).toBe(CONTENT_CAP + 100)
    expect(item.truncated).toBeUndefined()
    expect(item.thinking).toBe('secret')
  })
})

describe('mapTool', () => {
  it('stringifies + caps args/result and sums omitted chars', () => {
    const item = mapTool({ id: 't1', toolName: 'exec', exitStatus: '0', phase: 'completed', args: { cmd: 'x'.repeat(TOOL_CAP + 5) }, result: 'r'.repeat(TOOL_CAP + 7), createdAt: at(0) }, false)
    expect(item.kind).toBe('tool')
    expect(item.toolName).toBe('exec')
    expect(item.argsSnippet.length).toBe(TOOL_CAP)
    expect(item.resultSnippet.length).toBe(TOOL_CAP)
    expect(item.truncated).toBe(12)
  })
  it('handles null args/result', () => {
    const item = mapTool({ id: 't2', toolName: 'read', exitStatus: null, phase: 'completed', args: null, result: null, createdAt: at(0) }, false)
    expect(item.argsSnippet).toBe('')
    expect(item.resultSnippet).toBe('')
    expect(item.truncated).toBeUndefined()
  })
})

describe('interleave', () => {
  it('merges messages and tool events into one chronological array', () => {
    const msgs = [
      { id: 'm1', role: 'user', content: 'a', thinking: null, createdAt: at(0) },
      { id: 'm2', role: 'assistant', content: 'b', thinking: null, createdAt: at(20) }
    ]
    const tools = [{ id: 't1', toolName: 'exec', exitStatus: '0', phase: 'completed', args: {}, result: 'ok', createdAt: at(10) }]
    const items = interleave(msgs, tools, false)
    expect(items.map(i => i.id)).toEqual(['m1', 't1', 'm2'])
  })
})
