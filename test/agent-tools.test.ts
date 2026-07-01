// test/agent-tools.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools, toolByName } from '../server/lib/agent/tools'

describe('agent tool registry', () => {
  it('exposes the expected 29 tools', () => {
    const names = agentTools.map(t => t.name).sort()
    expect(names).toEqual([
      'create_project', 'create_task',
      'delete_document', 'delete_task',
      'edit_document', 'edit_image', 'edit_project', 'edit_section', 'edit_task',
      'forget_memory',
      'generate_image',
      'get_document', 'get_project', 'get_recent_memories',
      'grep_document',
      'list_documents',
      'move_document',
      'quick_capture', 'read_document',
      'save_document', 'save_memory',
      'search_docs', 'search_memories', 'search_passages', 'search_projects', 'search_tasks',
      'update_document',
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
  })

  it('every tool has a non-empty description and zod shape', () => {
    for (const t of agentTools) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.schema).toBe('object')
    }
  })
})
