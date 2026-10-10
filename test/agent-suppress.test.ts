// test/agent-suppress.test.ts
import { describe, it, expect } from 'vitest'
import { isSuppressedReply } from '@mymind/core/lib/agent/runtime/suppress'

describe('isSuppressedReply', () => {
  it.each([
    ['NO_REPLY', true],
    ['  NO_REPLY \n', true],
    ['NO_REPLY — nothing new since this morning.', true],
    ['Checked the queue. NO_REPLY', true],
    ['', false],
    ['Heads up: the deploy failed.', false],
    [`NO_REPLY ${'x'.repeat(301)}`, false],
    ['I would normally say NO_REPLY here but the build is red — here is why …', false]
  ])('%j → %s', (text, expected) => {
    expect(isSuppressedReply(text)).toBe(expected)
  })
})
