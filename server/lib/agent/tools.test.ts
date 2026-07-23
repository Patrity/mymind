// server/lib/agent/tools.test.ts
import { describe, it, expect } from 'vitest'
import { toolByName } from './tools'

describe('read tools', () => {
  it('read_document is a read tool with id/heading/offset/limit', () => {
    const t = toolByName('read_document')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['id', 'heading', 'offset', 'limit']))
  })
  it('grep_document is a read tool with id/pattern', () => {
    const t = toolByName('grep_document')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['id', 'pattern']))
  })
})

describe('edit tools', () => {
  it('edit tools are ungated (kind create, not dangerous)', () => {
    for (const name of ['edit_document', 'edit_section', 'update_document', 'move_document']) {
      const t = toolByName(name)
      expect(t, name).toBeDefined()
      expect(t!.kind, name).toBe('create')
      expect(t!.dangerous, name).toBeFalsy()
    }
  })
  it('edit_document takes old_string/new_string/replace_all', () => {
    expect(Object.keys(toolByName('edit_document')!.schema))
      .toEqual(expect.arrayContaining(['id', 'old_string', 'new_string', 'replace_all']))
  })
})

describe('delete tools', () => {
  it('delete tools are destructive but not hard-gated', () => {
    for (const name of ['delete_document', 'delete_task', 'forget_memory']) {
      const t = toolByName(name)
      expect(t, name).toBeDefined()
      expect(t!.kind, name).toBe('destructive')
      expect(t!.dangerous, name).toBeFalsy() // never dangerous → stays MCP-exposed, no approval channel needed
    }
  })
})

describe('edit_project — aliases + rename', () => {
  it('exposes aliases and newSlug and stays destructive', () => {
    const t = toolByName('edit_project')
    expect(t?.kind).toBe('destructive')
    expect(Object.keys(t!.schema)).toEqual(
      expect.arrayContaining(['slug', 'name', 'description', 'active', 'aliases', 'newSlug'])
    )
  })
})
