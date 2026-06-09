// test/chat-stream.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { assembleToolCalls, parseSseLine } from '../server/lib/ai/chat-stream'

describe('chat-stream parsing helpers', () => {
  it('parseSseLine extracts JSON payloads and detects DONE', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true })
    expect(parseSseLine('data: {"a":1}')).toEqual({ done: false, json: { a: 1 } })
    expect(parseSseLine(': heartbeat')).toEqual({ done: false })
    expect(parseSseLine('')).toEqual({ done: false })
  })

  it('assembleToolCalls merges streamed argument fragments by index', () => {
    const deltas = [
      [{ index: 0, id: 'call_1', function: { name: 'create_task', arguments: '{"ti' } }],
      [{ index: 0, function: { arguments: 'tle":"x"}' } }]
    ]
    const acc: Record<number, { id?: string; name?: string; args: string }> = {}
    for (const d of deltas) assembleToolCalls(acc, d)
    expect(acc[0]).toEqual({ id: 'call_1', name: 'create_task', args: '{"title":"x"}' })
  })
})
