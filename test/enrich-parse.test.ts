import { describe, it, expect } from 'vitest'
import { parseProposal } from '../server/lib/ai/enrich'

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
})
