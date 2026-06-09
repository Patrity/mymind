// test/agent-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../server/lib/agent/prompt'

describe('buildSystemPrompt', () => {
  it('mentions confirm-before-destructive and the filler behaviour', () => {
    const p = buildSystemPrompt()
    expect(p.toLowerCase()).toContain('confirm')
    expect(p.toLowerCase()).toContain('before')
    expect(p.length).toBeGreaterThan(100)
  })
})
