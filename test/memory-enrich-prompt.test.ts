import { describe, it, expect } from 'vitest'
import { buildEnrichTranscript } from '../server/services/memory-enrich'

type Msg = { id: string, role: string | null, content: string | null, thinking: string | null, isSidechain: boolean, metadata: unknown }

function makeMsg(overrides: Partial<Msg> & { id: string, content: string }): Msg {
  return {
    role: 'user',
    thinking: null,
    isSidechain: false,
    metadata: {},
    ...overrides
  }
}

describe('buildEnrichTranscript', () => {
  it('includes message ids in the output', () => {
    const msgs = [
      makeMsg({ id: 'msg-abc', role: 'user', content: 'Hello world' }),
      makeMsg({ id: 'msg-def', role: 'assistant', content: 'Hi there' })
    ]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).toContain('[msg-abc]')
    expect(result).toContain('[msg-def]')
  })

  it('includes thinking content, capped at 800 chars', () => {
    const longThinking = 't'.repeat(1000)
    const msgs = [
      makeMsg({ id: 'msg-1', role: 'assistant', content: 'Reply', thinking: longThinking })
    ]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).toContain('<thinking>')
    expect(result).toContain('</thinking>')
    // The thinking inside the tags should be at most 800 chars
    const thinkMatch = result.match(/<thinking>(.*?)<\/thinking>/s)
    expect(thinkMatch).not.toBeNull()
    expect(thinkMatch![1].length).toBeLessThanOrEqual(800)
  })

  it('includes short thinking verbatim', () => {
    const msgs = [
      makeMsg({ id: 'msg-1', role: 'assistant', content: 'Reply', thinking: 'short thought' })
    ]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).toContain('<thinking>short thought</thinking>')
  })

  it('excludes sidechain messages', () => {
    const msgs = [
      makeMsg({ id: 'msg-main', role: 'user', content: 'Main message', isSidechain: false }),
      makeMsg({ id: 'msg-side', role: 'assistant', content: 'Sidechain message', isSidechain: true })
    ]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).toContain('[msg-main]')
    expect(result).not.toContain('[msg-side]')
    expect(result).not.toContain('Sidechain message')
  })

  it('excludes messages with metadata.system_prompt === true', () => {
    const msgs = [
      makeMsg({ id: 'msg-normal', role: 'user', content: 'Normal message', metadata: {} }),
      makeMsg({ id: 'msg-sys', role: 'assistant', content: 'System prompt content', metadata: { system_prompt: true } })
    ]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).toContain('[msg-normal]')
    expect(result).not.toContain('[msg-sys]')
    expect(result).not.toContain('System prompt content')
  })

  it('includes tool usage line', () => {
    const msgs = [makeMsg({ id: 'msg-1', content: 'Hello' })]
    const tools = [
      { toolName: 'Bash', count: 5 },
      { toolName: 'Read', count: 3 }
    ]
    const result = buildEnrichTranscript(msgs, tools)
    expect(result).toContain('=== TOOL USAGE ===')
    expect(result).toContain('Bash×5')
    expect(result).toContain('Read×3')
  })

  it('shows (none) for tool usage when empty', () => {
    const msgs = [makeMsg({ id: 'msg-1', content: 'Hello' })]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).toContain('=== TOOL USAGE ===')
    expect(result).toContain('(none)')
  })

  it('elides middle content when transcript exceeds 12000 chars', () => {
    // Create many messages that total well over 12000 chars
    const msgs: Msg[] = []
    for (let i = 0; i < 100; i++) {
      msgs.push(makeMsg({ id: `msg-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(200) }))
    }
    const result = buildEnrichTranscript(msgs, [])
    expect(result.length).toBeLessThanOrEqual(12000 + 100) // allow a small buffer for the elision line itself
    expect(result).toContain('[... transcript trimmed ...]')
  })

  it('does not elide when transcript is under the limit', () => {
    const msgs = [
      makeMsg({ id: 'msg-1', role: 'user', content: 'Short message' }),
      makeMsg({ id: 'msg-2', role: 'assistant', content: 'Short reply' })
    ]
    const result = buildEnrichTranscript(msgs, [])
    expect(result).not.toContain('[... transcript trimmed ...]')
  })
})
