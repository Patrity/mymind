import { describe, it, expect } from 'vitest'
import { parseProposal, buildEnrichMessages } from '../server/lib/ai/enrich'
import type { DocumentDTO } from '../shared/types/documents'

// Minimal DocumentDTO stub for unit tests — only the fields buildEnrichMessages reads.
function makeDocDto(overrides: Partial<DocumentDTO> = {}): DocumentDTO {
  return {
    id: 'doc-1',
    path: '/input/test-note.md',
    title: 'Test Note',
    content: 'This is a test note about the mymind project.',
    language: 'en',
    frontmatter: {},
    project: null,
    domain: null,
    type: null,
    tags: [],
    topic: null,
    isPublic: false,
    publicSlug: null,
    ocrId: null,
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('parseProposal', () => {
  it('parses clean JSON', () => {
    const raw = JSON.stringify({
      title: 'Meeting Notes',
      project: 'my-project',
      domain: 'engineering',
      type: 'meeting',
      tags: ['planning', 'q2'],
      path: '/engineering/my-project/meeting-notes.md',
      reasoning: 'This is a meeting note.'
    })
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Meeting Notes')
    expect(result!.project).toBe('my-project')
    expect(result!.domain).toBe('engineering')
    expect(result!.type).toBe('meeting')
    expect(result!.tags).toEqual(['planning', 'q2'])
    expect(result!.path).toBe('/engineering/my-project/meeting-notes.md')
    expect(result!.reasoning).toBe('This is a meeting note.')
  })

  it('parses JSON wrapped in ```json fences', () => {
    const raw = '```json\n' + JSON.stringify({
      title: 'Fenced Note',
      project: 'fenced-proj',
      domain: 'health',
      type: 'note',
      tags: ['diet'],
      path: '/health/fenced-proj/note.md',
      reasoning: 'A health note.'
    }) + '\n```'
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Fenced Note')
    expect(result!.domain).toBe('health')
  })

  it('parses JSON with prose before and after', () => {
    const obj = {
      title: 'Prose Wrapped',
      project: null,
      domain: 'finance',
      type: 'reference',
      tags: ['budget', 'annual'],
      path: '/finance/budget-reference.md',
      reasoning: 'A finance reference document.'
    }
    const raw = `Here is the proposed frontmatter:\n${JSON.stringify(obj)}\nHope that helps!`
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Prose Wrapped')
    expect(result!.domain).toBe('finance')
    expect(result!.tags).toEqual(['budget', 'annual'])
  })

  it('returns null for garbage input', () => {
    expect(parseProposal('this is not JSON at all')).toBeNull()
    expect(parseProposal('')).toBeNull()
    expect(parseProposal('   ')).toBeNull()
    expect(parseProposal('{ not valid json }')).toBeNull()
  })

  it('coerces tags that are a single string into an array', () => {
    const raw = JSON.stringify({
      title: 'Tagged Doc',
      project: 'proj',
      domain: 'engineering',
      type: 'note',
      tags: 'single-tag',
      path: '/engineering/proj/doc.md',
      reasoning: 'A doc with string tags.'
    })
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.tags).toEqual(['single-tag'])
  })

  it('returns null when tags is a non-coercible non-array type (object)', () => {
    const raw = JSON.stringify({
      title: 'Bad Tags',
      project: 'proj',
      domain: 'engineering',
      type: 'note',
      tags: { foo: 'bar' },
      path: '/engineering/proj/doc.md',
      reasoning: 'Doc with object tags.'
    })
    const result = parseProposal(raw)
    // Object tags cannot be coerced to a string array — return null
    expect(result).toBeNull()
  })

  it('handles missing optional fields gracefully', () => {
    const raw = JSON.stringify({
      title: 'Minimal',
      domain: 'engineering',
      type: 'note'
    })
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Minimal')
    expect(result!.tags).toBeUndefined()
    expect(result!.project).toBeUndefined()
  })

  it('parses JSON with ```json fences and surrounding prose', () => {
    const obj = {
      title: 'Double Wrapped',
      project: 'dw-project',
      domain: 'engineering',
      type: 'idea',
      tags: ['architecture'],
      path: '/engineering/dw-project/idea.md',
      reasoning: 'An architectural idea.'
    }
    const raw = `I analyzed the document. Here is what I propose:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\nLet me know if you want changes.`
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Double Wrapped')
    expect(result!.project).toBe('dw-project')
  })

  it('accepts project slug + /projects/<slug>/ path together', () => {
    const raw = JSON.stringify({
      title: 'MyMind Feature',
      project: 'mymind',
      domain: 'engineering',
      type: 'note',
      tags: ['feature'],
      path: '/projects/mymind/x.md',
      reasoning: 'Belongs to the mymind project.'
    })
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.project).toBe('mymind')
    expect(result!.path).toBe('/projects/mymind/x.md')
  })

  it('accepts project: null with no path', () => {
    const raw = JSON.stringify({
      title: 'Unclassified Note',
      project: null,
      domain: 'misc',
      type: 'note',
      tags: [],
      reasoning: 'No clear project match.'
    })
    const result = parseProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.project).toBeNull()
    expect(result!.path).toBeUndefined()
  })
})

describe('buildEnrichMessages', () => {
  it('includes project slugs in the system message when projects are provided', () => {
    const doc = makeDocDto()
    const projects = [
      { slug: 'mymind', name: 'MyMind', description: 'Personal knowledge base' },
      { slug: 'side-project', name: 'Side Project', description: 'A side project' }
    ]
    const messages = buildEnrichMessages(doc, projects)
    const systemMsg = messages.find(m => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg!.content).toContain('mymind')
    expect(systemMsg!.content).toContain('side-project')
    expect(systemMsg!.content).toContain('MyMind')
    expect(systemMsg!.content).toContain('Personal knowledge base')
  })

  it('includes the /projects/<slug>/ path instruction in the system message', () => {
    const doc = makeDocDto()
    const projects = [{ slug: 'mymind', name: 'MyMind', description: 'Personal knowledge base' }]
    const messages = buildEnrichMessages(doc, projects)
    const systemMsg = messages.find(m => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg!.content).toContain('/projects/<that-slug>/<current-filename>')
  })

  it('instructs project: null when no projects are provided', () => {
    const doc = makeDocDto()
    const messages = buildEnrichMessages(doc, [])
    const systemMsg = messages.find(m => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg!.content).toContain('No projects are available')
    expect(systemMsg!.content).toContain('project to null')
  })

  it('includes the doc path and content in the user message', () => {
    const doc = makeDocDto({ path: '/input/my-note.md', content: 'Some content here' })
    const messages = buildEnrichMessages(doc, [])
    const userMsg = messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('/input/my-note.md')
    expect(userMsg!.content).toContain('Some content here')
  })

  it('returns exactly two messages: system + user', () => {
    const doc = makeDocDto()
    const messages = buildEnrichMessages(doc, [])
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('caps content at 6000 chars in the user message', () => {
    const longContent = 'x'.repeat(10000)
    const doc = makeDocDto({ content: longContent })
    const messages = buildEnrichMessages(doc, [])
    const userMsg = messages.find(m => m.role === 'user')
    // The content in the user message should be at most 6000 chars plus metadata overhead
    expect(userMsg!.content.length).toBeLessThan(10000)
    expect(userMsg!.content).not.toContain('x'.repeat(6001))
  })

  it('lists projects in slug — name — description format', () => {
    const doc = makeDocDto()
    const projects = [
      { slug: 'alpha', name: 'Alpha Project', description: 'The first project' }
    ]
    const messages = buildEnrichMessages(doc, projects)
    const systemMsg = messages.find(m => m.role === 'system')
    expect(systemMsg!.content).toContain('alpha — Alpha Project — The first project')
  })

  it('does not include /projects/ in path instruction when project list is empty', () => {
    const doc = makeDocDto()
    const messages = buildEnrichMessages(doc, [])
    const systemMsg = messages.find(m => m.role === 'system')
    // Empty list: must NOT include a project filing instruction
    expect(systemMsg!.content).not.toContain('/projects/<that-slug>/')
  })
})
