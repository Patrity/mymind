// test/agent-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../server/lib/agent/prompt'

describe('buildSystemPrompt', () => {
  it('always mentions confirm-before-destructive', () => {
    for (const isVoice of [true, false]) {
      const p = buildSystemPrompt(isVoice).toLowerCase()
      expect(p).toContain('confirm')
      expect(p).toContain('before')
      expect(p.length).toBeGreaterThan(100)
    }
  })

  it('includes the spoken-output + filler rules only in voice mode', () => {
    const voice = buildSystemPrompt(true).toLowerCase()
    const text = buildSystemPrompt(false).toLowerCase()
    expect(voice).toContain('speak out loud')
    expect(voice).toContain('filler')
    expect(text).not.toContain('speak out loud')
    expect(text).not.toContain('filler')
  })
})
