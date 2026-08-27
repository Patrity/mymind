import { describe, it, expect } from 'vitest'
import { conversationMessages } from '../server/db/schema/conversations'

describe('conversation_messages.usage', () => {
  it('exposes a usage column on the schema', () => {
    expect(Object.keys(conversationMessages)).toContain('usage')
  })
})
