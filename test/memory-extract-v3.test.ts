import { describe, it, expect, vi } from 'vitest'
import { parseExtractV3, extractV3, EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT } from '@mymind/core/lib/memory/extract-v3'

const mem = (content: string, confidence = 0.9) => ({ scope: 'agent', content, confidence, tags: ['x'] })

describe('parseExtractV3', () => {
  it('parses { memories, doc_candidates }', () => {
    const raw = JSON.stringify({
      memories: [mem('MyMind uses Drizzle ORM with Postgres.')],
      doc_candidates: [{ text: '  The ingest pipeline has three stages.  ', project: 'mymind', targetDocHint: 'wiki/ingest' }]
    })
    const out = parseExtractV3(raw)
    expect(out.memories).toHaveLength(1)
    expect(out.memories[0]!.content).toBe('MyMind uses Drizzle ORM with Postgres.')
    expect(out.docCandidates).toEqual([{ text: 'The ingest pipeline has three stages.', project: 'mymind', targetDocHint: 'wiki/ingest' }])
  })

  it('keeps the 0.6 confidence floor on memories', () => {
    const raw = JSON.stringify({ memories: [mem('durable', 0.9), mem('weeks', 0.5)], doc_candidates: [] })
    expect(parseExtractV3(raw).memories.map(m => m.content)).toEqual(['durable'])
  })

  it('gives [] when doc_candidates is missing', () => {
    const out = parseExtractV3(JSON.stringify({ memories: [mem('A fact.')] }))
    expect(out.memories).toHaveLength(1)
    expect(out.docCandidates).toEqual([])
  })

  it('drops candidates without text and normalises missing project/hint to null', () => {
    const raw = JSON.stringify({
      memories: [],
      doc_candidates: [{ text: '' }, { text: '   ' }, { project: 'mymind' }, 'a bare string', null, { text: 'Kept.', project: '  ', target_doc_hint: 'handover' }]
    })
    expect(parseExtractV3(raw).docCandidates).toEqual([{ text: 'Kept.', project: null, targetDocHint: 'handover' }])
  })

  it('keeps at most 5 candidates', () => {
    const raw = JSON.stringify({ memories: [], doc_candidates: Array.from({ length: 8 }, (_, i) => ({ text: `doc ${i}` })) })
    const out = parseExtractV3(raw)
    expect(out.docCandidates).toHaveLength(5)
    expect(out.docCandidates.map(c => c.text)).toEqual(['doc 0', 'doc 1', 'doc 2', 'doc 3', 'doc 4'])
  })

  it('parses a fenced reply with prose and braces inside strings', () => {
    const obj = {
      memories: [mem('extractV3 returns { memories, docCandidates }.')],
      doc_candidates: [{ text: 'Shape: { a: 1 } then } stray', project: null }]
    }
    const raw = 'Here you go:\n```json\n' + JSON.stringify(obj) + '\n```'
    const out = parseExtractV3(raw)
    expect(out.memories).toHaveLength(1)
    expect(out.docCandidates).toEqual([{ text: 'Shape: { a: 1 } then } stray', project: null, targetDocHint: null }])
  })

  it('handles escaped quotes inside strings (a "}" inside a quoted string does not end the object)', () => {
    const obj = {
      memories: [mem('Tony says "}" is not a closing brace.')],
      doc_candidates: [{ text: 'say "}" now, then \\ a backslash', project: 'mymind' }]
    }
    const out = parseExtractV3(JSON.stringify(obj))
    expect(out.memories.map(m => m.content)).toEqual(['Tony says "}" is not a closing brace.'])
    expect(out.docCandidates).toEqual([{ text: 'say "}" now, then \\ a backslash', project: 'mymind', targetDocHint: null }])
  })

  it('gives empty lists for garbage', () => {
    for (const raw of ['', '   ', 'no json here', '{ broken', '[1,2', 'null', '42']) {
      expect(parseExtractV3(raw)).toEqual({ memories: [], docCandidates: [] })
    }
  })
})

describe('extractV3', () => {
  it('calls the bulk chain with the v3 prompt and parses the reply', async () => {
    const chatFn = vi.fn(async () => JSON.stringify({ memories: [mem('A fact.')], doc_candidates: [{ text: 'A doc.' }] }))
    const out = await extractV3('[m1][user] hi', { chatFn: chatFn as never })
    expect(chatFn).toHaveBeenCalledTimes(1)
    const [alias, messages] = chatFn.mock.calls[0] as unknown as [string, { role: string, content: string }[]]
    expect(alias).toBe('bulk')
    expect(messages[0]).toEqual({ role: 'system', content: EXTRACT_SYSTEM_PROMPT })
    expect(messages[1]).toEqual({ role: 'user', content: '[m1][user] hi' })
    expect(out.memories).toHaveLength(1)
    expect(out.docCandidates).toEqual([{ text: 'A doc.', project: null, targetDocHint: null }])
  })

  it('prompt is versioned and asks for doc_candidates', () => {
    expect(EXTRACT_PROMPT_VERSION).toBe('extract-v3')
    expect(EXTRACT_SYSTEM_PROMPT).toContain('doc_candidates')
    expect(EXTRACT_SYSTEM_PROMPT).toContain('six months')
    expect(EXTRACT_SYSTEM_PROMPT).toContain('JUDGE THE FACT, NOT ITS WORDING')
    expect(EXTRACT_SYSTEM_PROMPT).toContain('Below 0.6 = do not extract')
    expect(EXTRACT_SYSTEM_PROMPT).toContain('precisely-observed fact')
  })
})
