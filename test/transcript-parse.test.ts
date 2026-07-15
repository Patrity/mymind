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

// ---------------------------------------------------------------------------
// NUL byte (U+0000) sanitisation — Postgres text AND jsonb columns reject it.
// CC transcripts legitimately carry it (binary tool output, or source code that
// contains a literal  escape), which otherwise 500s the whole delta.
// ---------------------------------------------------------------------------

describe('parseTranscriptLines — NUL byte sanitisation', () => {
  // A real NUL char in JS → JSON.stringify emits the  escape → JSON.parse
  // yields a real NUL again inside the parsed value (the production failure mode).
  const NUL = String.fromCharCode(0)
  const nulTextLine = JSON.stringify({
    uuid: 'nul1',
    message: { role: 'assistant', content: [{ type: 'text', text: `before${NUL}after` }] }
  })
  const nulToolUseLine = JSON.stringify({
    uuid: 'nul2',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tuN', name: 'Bash', input: { command: `raw.replace(/[${NUL}]/g)` } }]
    }
  })
  const nulToolResultLine = JSON.stringify({
    uuid: 'nul3',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuN', content: `out${NUL}put` }] }
  })
  const nulThinkingLine = JSON.stringify({
    uuid: 'nul4',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: `ponder${NUL}ing` }] }
  })

  it('strips NUL from message content but keeps the surrounding text', () => {
    const m = parseTranscriptLines([nulTextLine]).messages.find(x => x.role === 'assistant')!
    expect(m.content).toBe('beforeafter')
    expect(m.content).not.toContain(NUL)
  })

  it('strips NUL from thinking', () => {
    const m = parseTranscriptLines([nulThinkingLine]).messages.find(x => x.thinking)!
    expect(m.thinking).toBe('pondering')
  })

  it('strips NUL from tool args and result (jsonb columns)', () => {
    const r = parseTranscriptLines([nulToolUseLine, nulToolResultLine])
    const ev = r.toolEvents.find(e => e.toolUseId === 'tuN')!
    // no NUL survives anywhere in the nested structures...
    expect(JSON.stringify(ev.args)).not.toContain('\\u0000')
    expect(JSON.stringify(ev.result)).not.toContain('\\u0000')
    // ...but the real payload is preserved
    expect(JSON.stringify(ev.args)).toContain('raw.replace')
    expect(String(ev.result)).toBe('output')
  })

  it('leaves NUL-free input untouched', () => {
    const r = parseTranscriptLines([assistantLine, toolUseLine, toolResultLine])
    const asst = r.messages.find(m => m.role === 'assistant' && m.content)!
    expect(asst.content).toBe('Sure, I will do that.')
    expect(r.toolEvents[0]!.args).toEqual({ command: 'ls' })
  })
})
