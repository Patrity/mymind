// test/agent-tools.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools, toolByName } from '../server/lib/agent/tools'
import { MCP_INSTRUCTIONS } from '../server/lib/mcp/server'

describe('agent tool registry', () => {
  it('exposes the expected 48 tools', () => {
    const names = agentTools.map(t => t.name).sort()
    expect(names).toEqual([
      'create_job', 'create_project', 'create_skill', 'create_task',
      'delete_document', 'delete_job', 'delete_skill', 'delete_task',
      'edit_document', 'edit_image', 'edit_job', 'edit_project', 'edit_section', 'edit_skill', 'edit_task',
      'forget_memory',
      'generate_image',
      'get_document', 'get_job', 'get_project', 'get_recent_memories',
      'grep_document',
      'list_documents', 'list_improvements', 'list_jobs', 'list_reviews',
      'move_document',
      'quick_capture', 'read_around_message', 'read_document', 'read_session', 'run_job',
      'save_document', 'save_memory', 'schedule_wake',
      'search_docs', 'search_memories', 'search_messages', 'search_passages', 'search_projects', 'search_sessions', 'search_tasks',
      'send_message',
      'sync_document',
      'update_document',
      'use_skill',
      'web_fetch', 'web_search'
    ])
  })

  it('classifies tool kinds correctly', () => {
    expect(toolByName('search_tasks')!.kind).toBe('read')
    expect(toolByName('create_task')!.kind).toBe('create')
    expect(toolByName('edit_task')!.kind).toBe('destructive')
    expect(toolByName('quick_capture')!.kind).toBe('create')
    expect(toolByName('get_project')!.kind).toBe('read')
    expect(toolByName('list_documents')!.kind).toBe('read')
    expect(toolByName('get_document')!.kind).toBe('read')
    expect(toolByName('save_document')!.kind).toBe('create')
    expect(toolByName('list_jobs')!.kind).toBe('read')
    expect(toolByName('get_job')!.kind).toBe('read')
    expect(toolByName('create_job')!.kind).toBe('create')
    expect(toolByName('edit_job')!.kind).toBe('create')
    expect(toolByName('run_job')!.kind).toBe('create')
    expect(toolByName('schedule_wake')!.kind).toBe('create')
    expect(toolByName('delete_job')!.kind).toBe('destructive')
  })

  it('every tool has a non-empty description and zod shape', () => {
    for (const t of agentTools) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.schema).toBe('object')
    }
  })
})

describe('MCP preamble', () => {
  it('points agents at sync_document', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/sync_document/)
  })

  it('does not promise that every write is reversible', () => {
    expect(MCP_INSTRUCTIONS).not.toMatch(/All are reversible via undo/)
  })

  // MCP_INSTRUCTIONS is consumed ONLY by buildMcpServer, and that surface hands out no undo
  // token: no `undo` tool exists in agentTools, and POST /api/agent/undo is unreachable from an
  // MCP session. So any undo advice here — "most writes are undoable", "check the undo result" —
  // is advice about a capability its only audience cannot invoke.
  it('offers no undo advice an MCP client cannot act on', () => {
    expect(MCP_INSTRUCTIONS).not.toMatch(/undoable|reversible/i)
    expect(MCP_INSTRUCTIONS).toMatch(/no undo tool/i)
  })

  // The preamble is prepended to every MCP session; it earns its tokens or it goes.
  it('stays within its budget', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(998)
  })
})
