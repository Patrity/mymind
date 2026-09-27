import { describe, it, expect } from 'vitest'
import { routeFrame } from '../server/lib/voice/ws-routing'

describe('routeFrame', () => {
  it.each([
    [{ type: 'interrupt' }, { kind: 'abort' }],
    [{ type: 'load', conversationId: 'c1' }, { kind: 'load', conversationId: 'c1' }],
    [{ type: 'attach' }, { kind: 'attach' }],
    [{ type: 'new' }, { kind: 'new' }],
    [{ type: 'clear' }, { kind: 'clear' }],
    [{ type: 'text', text: '  hi  ', speak: true, skill: 'db-maintenance' }, { kind: 'text', text: 'hi', speak: true, skill: 'db-maintenance', attachments: [] }],
    [{ type: 'text', text: 'x' }, { kind: 'text', text: 'x', speak: false, attachments: [] }],
    [{ type: 'text', text: '   ' }, { kind: 'ignore' }],
    [{ type: 'preset', presetId: '' }, { kind: 'preset', presetId: null }],
    [{ type: 'model', modelDefId: 'm1' }, { kind: 'model', modelDefId: 'm1' }],
    [{ type: 'approve', requestId: 'r1', remember: true, pattern: 'exec ls*' }, { kind: 'approve', requestId: 'r1', remember: true, pattern: 'exec ls*' }],
    [{ type: 'deny', requestId: 'r1' }, { kind: 'deny', requestId: 'r1' }],
    [{ type: 'profile' }, { kind: 'ignore' }],
    [{ type: 'load' }, { kind: 'ignore' }]
  ])('%j', (msg, action) => {
    expect(routeFrame(msg as Record<string, unknown>)).toEqual(action)
  })
})
