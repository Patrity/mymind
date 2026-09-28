// buildTurnPersistPayload's `origin` (cycle 75): an inbound iMessage's user row carries
// `imessage:<chatGuid>` so the UI can mark it; the assistant row never does.
import { describe, it, expect } from 'vitest'
import { buildTurnPersistPayload, type TurnPersistContext } from '../server/lib/voice/turn-persist'
import type { AgentMessage } from '../server/lib/agent/run'

const added = [
  { role: 'user', content: 'hey bridget' },
  { role: 'assistant', content: 'hi' }
] as AgentMessage[]
const base: TurnPersistContext = { inputModality: 'text', speakFlag: false, attachments: [], reasoning: '', usage: null }

describe('buildTurnPersistPayload origin', () => {
  it('stamps ctx.origin on the user row only', () => {
    const [user, assistant] = buildTurnPersistPayload(added, { ...base, origin: 'imessage:iMessage;-;+15551234567' })
    expect(user!.origin).toBe('imessage:iMessage;-;+15551234567')
    expect(assistant!.origin ?? null).toBeNull()
  })

  it('leaves origin null when the turn came from the app', () => {
    const rows = buildTurnPersistPayload(added, base)
    expect(rows.map(r => r.origin ?? null)).toEqual([null, null])
  })
})
