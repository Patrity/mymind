import { describe, it, expect } from 'vitest'
import { mapSession, mapMessage, mapToolEvent } from '../server/lib/migrate/bridget-map'

describe('mapSession', () => {
  it('maps columns, prefers machine_id then host, drops embeddings', () => {
    const r = { source: 'claude_code', external_id: 'sess-1', project: 'mymind', host: 'h1',
      machine_id: 'm1', cwd: '/x', git_branch: 'main', git_commit: 'abc', git_remote: 'r',
      app_version: '1.2', title: 'T', summary: 'S', started_at: new Date('2026-01-01'),
      last_active: new Date('2026-01-02'), ended_at: null, message_count: 5, tool_count: 2, metadata: { a: 1 } }
    const m = mapSession(r)
    expect(m.source).toBe('claude_code')
    expect(m.externalId).toBe('sess-1')
    expect(m.machineId).toBe('m1')
    expect(m.gitBranch).toBe('main')
    expect(m.title).toBe('T')
    expect(m.metadata).toEqual({ a: 1 })
    expect('summary_embedding' in m).toBe(false)
  })
  it('falls back to host when machine_id is null', () => {
    expect(mapSession({ source: 'x', external_id: 'y', machine_id: null, host: 'h9' }).machineId).toBe('h9')
  })
})

describe('mapMessage', () => {
  it('maps rich fields, drops token_count/embedding', () => {
    const r = { role: 'assistant', content: 'hi', external_uuid: 'u1', parent_uuid: 'p1',
      thinking: 'th', model: 'claude-opus-4-8', request_id: 'req', stop_reason: 'end_turn',
      is_sidechain: true, usage: { input_tokens: 1 }, created_at: new Date('2026-01-01'), metadata: {} }
    const m = mapMessage(r)
    expect(m.role).toBe('assistant')
    expect(m.externalUuid).toBe('u1')
    expect(m.thinking).toBe('th')
    expect(m.isSidechain).toBe(true)
    expect(m.usage).toEqual({ input_tokens: 1 })
    expect('token_count' in m).toBe(false)
    expect('embedding' in m).toBe(false)
  })
})

describe('mapToolEvent', () => {
  it('maps fields, drops duration_ms', () => {
    const r = { tool_name: 'Bash', args: { c: 'ls' }, result: 'ok', exit_status: 'ok',
      phase: 'completed', tool_use_id: 'tu1', is_sidechain: false, caller_type: 'direct',
      created_at: new Date('2026-01-01') }
    const m = mapToolEvent(r)
    expect(m.toolName).toBe('Bash')
    expect(m.toolUseId).toBe('tu1')
    expect(m.exitStatus).toBe('ok')
    expect('duration_ms' in m).toBe(false)
  })
})
