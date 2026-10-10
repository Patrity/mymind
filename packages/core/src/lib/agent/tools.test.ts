// server/lib/agent/tools.test.ts
import { describe, it, expect, vi } from 'vitest'
import { toolByName, agentTools } from './tools'
import { getDoc } from '../../services/documents'

// The mock must export EVERY name tools.ts imports (see tools.ts:5) or the module fails to load.
vi.mock('../../services/documents', () => ({
  searchPassages: vi.fn(), createDoc: vi.fn(), getDoc: vi.fn(async () => null),
  deleteDoc: vi.fn(), updateDoc: vi.fn(), moveDoc: vi.fn(), restoreDoc: vi.fn(),
  listDocsSummary: vi.fn(), countDocs: vi.fn(), searchDocsPage: vi.fn(),
  findDocByPath: vi.fn(), casUpdateContent: vi.fn()
}))

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

describe('session tools', () => {
  it('are all read tools with the right schema keys', () => {
    expect(toolByName('search_messages')!.kind).toBe('read')
    expect(Object.keys(toolByName('search_messages')!.schema)).toEqual(expect.arrayContaining(['query', 'project', 'session', 'limit']))
    expect(toolByName('search_sessions')!.kind).toBe('read')
    expect(toolByName('read_around_message')!.kind).toBe('read')
    expect(Object.keys(toolByName('read_around_message')!.schema)).toEqual(expect.arrayContaining(['messageId', 'radius', 'full']))
    expect(toolByName('read_session')!.kind).toBe('read')
    expect(Object.keys(toolByName('read_session')!.schema)).toEqual(expect.arrayContaining(['sessionId', 'offset', 'limit', 'full']))
    for (const n of ['search_messages', 'search_sessions', 'read_around_message', 'read_session']) expect(toolByName(n)!.dangerous, n).toBeFalsy()
  })
})

describe('document tools: unified failure shape', () => {
  const tool = (n: string) => agentTools.find(t => t.name === n)!
  const ctx = { signal: new AbortController().signal }

  for (const name of ['read_document', 'grep_document', 'delete_document']) {
    it(`${name} returns {ok:false, error:'not_found'} for a missing doc`, async () => {
      const r = await tool(name).handler({ id: 'nope', pattern: 'x' }, ctx as never)
      expect(r.result).toMatchObject({ ok: false, error: 'not_found', message: 'document not found' })
    })
  }

  it('update_document returns no_fields when the patch is empty', async () => {
    vi.mocked(getDoc).mockResolvedValueOnce({ id: 'x', content: '', path: '/p.md' } as never)
    const r = await tool('update_document').handler({ id: 'x' }, ctx as never)
    expect(r.result).toMatchObject({ ok: false, error: 'no_fields' })
  })

  // These exercise the other converted sites — the ones where the op-failure `{ error, message }`
  // from edit-ops.ts is spread into the tool result (`{ ok: false, ...res }`), not the docNotFound
  // sites above. Before the fix these returned `{ error, outline }` with no `ok` field, so
  // `toMatchObject({ ok: false, ... })` would fail on the missing key.
  it('grep_document returns invalid_regex with a message for a bad pattern', async () => {
    vi.mocked(getDoc).mockResolvedValueOnce({ id: 'x', content: 'hello', path: '/p.md' } as never)
    const r = await tool('grep_document').handler({ id: 'x', pattern: '(', regex: true }, ctx as never)
    expect(r.result).toMatchObject({ ok: false, error: 'invalid_regex' })
    expect((r.result as { message?: string }).message).toBeTruthy()
  })

  it('read_document returns heading_not_found with a message and a clipped outline', async () => {
    vi.mocked(getDoc).mockResolvedValueOnce({ id: 'x', content: '# A\n\ntext', path: '/p.md' } as never)
    const r = await tool('read_document').handler({ id: 'x', heading: 'Nope' }, ctx as never)
    expect(r.result).toMatchObject({ ok: false, error: 'heading_not_found' })
    expect((r.result as { message?: string }).message).toBeTruthy()
    expect((r.result as { outline?: unknown[] }).outline).toBeDefined()
  })

  it('edit_section returns heading_not_found with a message and a clipped outline', async () => {
    vi.mocked(getDoc).mockResolvedValueOnce({ id: 'x', content: '# A\n\ntext', path: '/p.md' } as never)
    const r = await tool('edit_section').handler({ id: 'x', mode: 'replace', heading: 'Nope', text: 'new' }, ctx as never)
    expect(r.result).toMatchObject({ ok: false, error: 'heading_not_found' })
    expect((r.result as { message?: string }).message).toBeTruthy()
    expect((r.result as { outline?: unknown[] }).outline).toBeDefined()
  })
})
