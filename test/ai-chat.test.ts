// test/ai-chat.test.ts
import { describe, it, expect } from 'vitest'
import { extractContent } from '../server/lib/ai/chat'
import { withFailoverOver } from '../server/lib/ai/registry/resolve'
import type { ResolvedModel } from '../server/lib/ai/registry/types'

describe('extractContent', () => {
  it('returns the assistant content for a well-formed completion', () => {
    expect(extractContent({ choices: [{ message: { content: '{"ok":true}' } }] })).toBe('{"ok":true}')
  })

  it('throws when choices are missing (e.g. an HTML/error body returned with HTTP 200)', () => {
    expect(() => extractContent('<!DOCTYPE html><html></html>')).toThrow()
    expect(() => extractContent({})).toThrow()
    expect(() => extractContent({ choices: [] })).toThrow()
  })

  it('throws on empty/whitespace content rather than returning it', () => {
    expect(() => extractContent({ choices: [{ message: { content: '' } }] })).toThrow()
    expect(() => extractContent({ choices: [{ message: { content: '   ' } }] })).toThrow()
    expect(() => extractContent({ choices: [{ message: {} }] })).toThrow()
  })
})

describe('extractContent + withFailover', () => {
  const chain: ResolvedModel[] = [
    { usage: 'reasoning', modelDefId: 'm1', providerKind: 'openai-compatible', baseURL: 'http://a', apiKey: 'k', modelId: 'broken', label: 'Broken', dim: null },
    { usage: 'reasoning', modelDefId: 'm2', providerKind: 'openai-compatible', baseURL: 'http://b', apiKey: 'k', modelId: 'good', label: 'Good', dim: null }
  ]

  it('fails over past a model that returns no usable content (the bug: a 200 + empty body must not look like success)', async () => {
    const out = await withFailoverOver('reasoning', chain, async (m) => {
      // Simulate the misconfigured provider that returned a 200 HTML shell.
      const res = m.modelId === 'broken' ? '<!DOCTYPE html>' : { choices: [{ message: { content: 'real answer' } }] }
      return extractContent(res)
    })
    expect(out).toBe('real answer')
  })
})
