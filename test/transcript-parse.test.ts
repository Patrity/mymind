import { describe, it, expect } from 'vitest'
import { parseTranscriptLines } from '../server/services/transcript-parse'

// ---------------------------------------------------------------------------
// Sample JSONL lines
// ---------------------------------------------------------------------------

const userLine = JSON.stringify({
  uuid: 'u1',
  message: { role: 'user', content: 'do a thing' }
})

const assistantLine = JSON.stringify({
  uuid: 'a1',
  message: {
    role: 'assistant',
    model: 'claude-3-7-sonnet-20250219',
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [
      { type: 'text', text: 'Sure, I will do that.' }
    ]
  }
})

const toolUseLine = JSON.stringify({
  uuid: 'a2',
  message: {
    role: 'assistant',
    model: 'claude-3-7-sonnet-20250219',
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }
    ]
  }
})

const toolResultLine = JSON.stringify({
  uuid: 'tr1',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'file1.txt\nfile2.txt' }
    ]
  }
})

const unparseable = 'not json at all {'

const cacheAssistantLine = JSON.stringify({
  uuid: 'a3',
  message: {
    role: 'assistant',
    model: 'claude-3-7-sonnet-20250219',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50
    },
    content: [{ type: 'text', text: 'cached response' }]
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseTranscriptLines', () => {
  it('returns empty result for empty input', () => {
    const result = parseTranscriptLines([])
    expect(result.messages).toHaveLength(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.toolCount).toBe(0)
  })

  it('skips unparseable lines without throwing', () => {
    expect(() => parseTranscriptLines([unparseable])).not.toThrow()
    const result = parseTranscriptLines([unparseable])
    expect(result.messages).toHaveLength(0)
  })

  it('parses a user message correctly', () => {
    const result = parseTranscriptLines([userLine])
    expect(result.messages).toHaveLength(1)
    const msg = result.messages[0]!
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('do a thing')
    expect(msg.externalUuid).toBe('u1')
    expect(msg.metadata).toEqual({})
  })

  it('accumulates inputTokens and outputTokens from assistant lines', () => {
    const result = parseTranscriptLines([userLine, assistantLine])
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
  })

  it('stores usage and model in assistant message metadata', () => {
    const result = parseTranscriptLines([assistantLine])
    const asst = result.messages.find(m => m.role === 'assistant')!
    expect(asst).toBeDefined()
    expect(asst.metadata.usage).toMatchObject({ input_tokens: 100, output_tokens: 50 })
    expect(asst.metadata.model).toBe('claude-3-7-sonnet-20250219')
  })

  it('counts tool_use parts toward toolCount', () => {
    const result = parseTranscriptLines([toolUseLine])
    expect(result.toolCount).toBeGreaterThanOrEqual(1)
  })

  it('emits a message for tool-only assistant turn with metadata.tools', () => {
    const result = parseTranscriptLines([toolUseLine])
    const toolMsg = result.messages.find(m => m.role === 'assistant')!
    expect(toolMsg).toBeDefined()
    expect(toolMsg.metadata.tools).toEqual(['Bash'])
    expect(toolMsg.content).toBe('')
  })

  it('skips a standalone pure tool_result line (no matching tool_use)', () => {
    const result = parseTranscriptLines([toolResultLine])
    expect(result.messages).toHaveLength(0)
    expect(result.toolEvents).toHaveLength(0)
  })

  it('full scenario: correct totals across 4 lines', () => {
    const result = parseTranscriptLines([userLine, assistantLine, toolUseLine, toolResultLine])
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
    expect(result.toolCount).toBe(1) // one tool_use → one event (closed by the result)
    expect(result.messages.length).toBe(3) // pure tool_result row skipped
  })

  it('adds cache tokens to inputTokens', () => {
    const result = parseTranscriptLines([cacheAssistantLine])
    // 10 + 200 (cache_read) + 50 (cache_creation) = 260
    expect(result.inputTokens).toBe(260)
    expect(result.outputTokens).toBe(5)
  })

  it('never throws on malformed/missing fields', () => {
    const weirdLines = [
      '{}',
      '{"uuid":"x"}',
      '{"message":{}}',
      '{"message":{"role":"assistant","content":null}}',
      '{"type":"system","content":"irrelevant"}'
    ]
    expect(() => parseTranscriptLines(weirdLines)).not.toThrow()
  })
})
