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

describe('skill tools', () => {
  it('use_skill is a read tool taking a name', () => {
    const t = toolByName('use_skill')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['name']))
  })
  it('authoring tools are ungated (autonomous self-improvement), delete is destructive', () => {
    expect(toolByName('create_skill')!.kind).toBe('create')
    expect(toolByName('edit_skill')!.kind).toBe('create')
    expect(toolByName('delete_skill')!.kind).toBe('destructive')
    for (const n of ['use_skill', 'create_skill', 'edit_skill', 'delete_skill']) {
      expect(toolByName(n)!.dangerous, n).toBeFalsy()
    }
  })
  it('create_skill takes the full frontmatter contract', () => {
    expect(Object.keys(toolByName('create_skill')!.schema))
      .toEqual(expect.arrayContaining(['name', 'description', 'whenToUse', 'body']))
  })
  it('edit_skill can patch any field including active', () => {
    expect(Object.keys(toolByName('edit_skill')!.schema))
      .toEqual(expect.arrayContaining(['name', 'description', 'whenToUse', 'body', 'active']))
  })
})
