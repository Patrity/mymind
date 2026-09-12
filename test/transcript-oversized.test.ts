import { describe, it, expect } from 'vitest'
import { parseTranscriptLines, MAX_FIELD_CHARS } from '../server/services/transcript-parse'
import { TranscriptBody, MAX_LINES, MAX_BODY_CHARS } from '../server/lib/transcript/ingest-limits'

// ---------------------------------------------------------------------------
// Regression: a single oversized JSONL line used to 400 the WHOLE batch
// (`z.string().max(100_000)` per line). Because cc-hook only advances its byte
// offset on a 2xx, that one line wedged the session's entire stream forever —
// 324 sessions and 1.54 GB of transcript were stuck behind ~0.4% of lines.
// ---------------------------------------------------------------------------

const bigText = 'x'.repeat(1_200_000)

const oversizedAssistant = JSON.stringify({
  uuid: 'big1',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'text', text: bigText }]
  }
})

const smallAssistant = JSON.stringify({
  uuid: 'small1',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
})

const oversizedToolResult = [
  JSON.stringify({
    uuid: 'a9',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tuBig', name: 'Bash', input: { command: 'cat huge' } }]
    }
  }),
  JSON.stringify({
    uuid: 'tr9',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tuBig', content: bigText }]
    }
  })
]

describe('oversized transcript lines', () => {
  it('accepts a line far past the old 100k per-line cap', () => {
    const r = TranscriptBody.safeParse({
      source: 'claude_code',
      external_id: 's1',
      lines: [oversizedAssistant]
    })
    expect(r.success).toBe(true)
  })

  it('still ingests the message on an oversized line instead of dropping the batch', () => {
    const r = parseTranscriptLines([oversizedAssistant, smallAssistant])
    // both survive — the big one must not take the small one down with it
    expect(r.messages.map(m => m.externalUuid).sort()).toEqual(['big1', 'small1'])
  })

  it('clamps the oversized field rather than truncating the raw line', () => {
    // Truncating the JSONL line itself would break JSON.parse and silently drop
    // the message; the clamp has to happen on the PARSED field.
    const r = parseTranscriptLines([oversizedAssistant])
    const msg = r.messages.find(m => m.externalUuid === 'big1')!
    expect(msg.content.length).toBeLessThanOrEqual(MAX_FIELD_CHARS)
    expect(msg.content.startsWith('xxxx')).toBe(true)
    expect(msg.content).toContain('truncated')
  })

  it('clamps oversized tool results (jsonb)', () => {
    const r = parseTranscriptLines(oversizedToolResult)
    const ev = r.toolEvents.find(e => e.toolUseId === 'tuBig')!
    expect(ev.phase).toBe('completed')
    expect(JSON.stringify(ev.result).length).toBeLessThanOrEqual(MAX_FIELD_CHARS + 200)
  })

  it('leaves normal-sized content untouched', () => {
    const r = parseTranscriptLines([smallAssistant])
    expect(r.messages[0]!.content).toBe('hi')
  })

  it('still rejects a batch that is absurdly large in total', () => {
    const r = TranscriptBody.safeParse({
      source: 'claude_code',
      external_id: 's1',
      lines: ['y'.repeat(MAX_BODY_CHARS + 1)]
    })
    expect(r.success).toBe(false)
  })

  it('allows more lines than the old 5000 cap', () => {
    const r = TranscriptBody.safeParse({
      source: 'claude_code',
      external_id: 's1',
      lines: Array.from({ length: 6000 }, () => smallAssistant)
    })
    expect(r.success).toBe(true)
    expect(MAX_LINES).toBeGreaterThan(5000)
  })
})
