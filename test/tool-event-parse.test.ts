import { describe, it, expect } from 'vitest'
import { parseTranscriptLines } from '../server/services/transcript-parse'

const asstThinking = JSON.stringify({
  uuid: 'a1', parentUuid: 'u0', requestId: 'req_1',
  message: {
    role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
    content: [
      { type: 'thinking', thinking: 'Let me reason about this.' },
      { type: 'text', text: 'Here is the answer.' }
    ]
  }
})
const asstToolUse = JSON.stringify({
  uuid: 'a2', isSidechain: true,
  message: { role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' }, caller: { type: 'direct' } }] }
})
const userToolResultOk = JSON.stringify({
  uuid: 'tr1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1.txt' }] }
})
const userToolResultErr = JSON.stringify({
  uuid: 'tr2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }] }
})
const asstToolUse2 = JSON.stringify({
  uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { path: '/x' } }] }
})
const longPreamble = JSON.stringify({ message: { role: 'user', content: 'X'.repeat(250) } })

describe('parseTranscriptLines — rich capture', () => {
  it('extracts thinking separate from text, plus model/stopReason/requestId/parentUuid', () => {
    const r = parseTranscriptLines([asstThinking])
    const m = r.messages.find(x => x.role === 'assistant')!
    expect(m.content).toBe('Here is the answer.')
    expect(m.thinking).toBe('Let me reason about this.')
    expect(m.model).toBe('claude-opus-4-8')
    expect(m.stopReason).toBe('end_turn')
    expect(m.requestId).toBe('req_1')
    expect(m.parentUuid).toBe('u0')
    expect(m.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 })
  })
  it('emits a tool event from a tool_use block with args + caller + sidechain', () => {
    const r = parseTranscriptLines([asstToolUse])
    expect(r.toolEvents).toHaveLength(1)
    const te = r.toolEvents[0]!
    expect(te.toolName).toBe('Bash')
    expect(te.toolUseId).toBe('tu1')
    expect(te.args).toMatchObject({ command: 'ls' })
    expect(te.phase).toBe('pre')
    expect(te.callerType).toBe('direct')
    expect(te.isSidechain).toBe(true)
    expect(te.parentExternalUuid).toBe('a2')
  })
  it('closes a tool event on a matching tool_result (ok)', () => {
    const r = parseTranscriptLines([asstToolUse, userToolResultOk])
    const te = r.toolEvents.find(e => e.toolUseId === 'tu1')!
    expect(te.phase).toBe('completed')
    expect(te.exitStatus).toBe('ok')
    expect(te.result).toBe('file1.txt')
  })
  it('marks a tool event failed on an error tool_result', () => {
    const r = parseTranscriptLines([asstToolUse2, userToolResultErr])
    const te = r.toolEvents.find(e => e.toolUseId === 'tu2')!
    expect(te.phase).toBe('failed')
    expect(te.exitStatus).toBe('error')
  })
  it('skips a pure tool_result message row but still records the event', () => {
    const r = parseTranscriptLines([asstToolUse, userToolResultOk])
    expect(r.messages.some(m => m.externalUuid === 'tr1')).toBe(false)
    expect(r.toolEvents.find(e => e.toolUseId === 'tu1')!.exitStatus).toBe('ok')
  })
  it('flags a long no-uuid user preamble as system_prompt', () => {
    const r = parseTranscriptLines([longPreamble])
    expect(r.messages[0]!.metadata.system_prompt).toBe(true)
  })
  it('defaults isSidechain to false', () => {
    const r = parseTranscriptLines([asstThinking])
    expect(r.messages[0]!.isSidechain).toBe(false)
  })
})
