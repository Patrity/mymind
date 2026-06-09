// test/openai-chunk.test.ts
import { describe, it, expect } from 'vitest'
import { textChunk, doneFrame } from '../server/lib/agent/openai-chunk'

describe('openai chunk framing', () => {
  it('frames a text delta as an OpenAI streaming chunk line', () => {
    const line = textChunk('hi')
    expect(line.startsWith('data: ')).toBe(true)
    const obj = JSON.parse(line.slice(6).trim())
    expect(obj.choices[0].delta.content).toBe('hi')
    expect(obj.object).toBe('chat.completion.chunk')
  })
  it('doneFrame is the OpenAI terminator', () => {
    expect(doneFrame()).toBe('data: [DONE]\n\n')
  })
})
