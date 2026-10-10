import { describe, it, expect } from 'vitest'
import { outline, findSection, readSection, documentStats, grepContent, applyReplace, applyEditSection, clipOutline, MAX_ERROR_OUTLINE } from './edit-ops'

const DOC = [
  '# Title',            // 1
  'intro line',         // 2
  '',                   // 3
  '## Alpha',           // 4
  'alpha body',         // 5
  '',                   // 6
  '## Beta',            // 7
  'beta body 1',        // 8
  'beta body 2',        // 9
  '### Beta child',     // 10
  'child body',         // 11
  '## Alpha',           // 12  (duplicate heading → ambiguous)
  'second alpha',       // 13
].join('\n')

describe('outline', () => {
  it('lists ATX headings with 1-indexed lines and levels', () => {
    expect(outline(DOC)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Alpha', line: 4 },
      { level: 2, text: 'Beta', line: 7 },
      { level: 3, text: 'Beta child', line: 10 },
      { level: 2, text: 'Alpha', line: 12 },
    ])
  })
  it('ignores # inside fenced code blocks', () => {
    const c = ['# Real', '```', '# not a heading', '```', '## Also real'].join('\n')
    expect(outline(c).map(h => h.text)).toEqual(['Real', 'Also real'])
  })
  it('keeps inline # in heading text but strips closing hashes', () => {
    expect(outline('## Fix #42').map(h => h.text)).toEqual(['Fix #42'])
    expect(outline('## Foo ##').map(h => h.text)).toEqual(['Foo'])
  })
})

describe('findSection', () => {
  it('spans a section to the next same-or-higher heading', () => {
    // "Beta" (level 2) body runs line 7..9 — stops before its level-3 child? No: child is deeper, so it is INCLUDED. Next level<=2 is line 12.
    expect(findSection(DOC, 'Beta')).toEqual({ startLine: 7, endLine: 11, level: 2 })
  })
  it('errors when the heading is missing', () => {
    expect(findSection(DOC, 'Nope')).toEqual({ error: 'heading_not_found', message: 'heading not found: "Nope"' })
  })
  it('errors when the heading is ambiguous', () => {
    expect(findSection(DOC, 'Alpha')).toEqual({ error: 'ambiguous_heading', message: 'heading "Alpha" is ambiguous (2 matches)' })
  })
})

describe('readSection', () => {
  it('returns a heading section text + span', () => {
    expect(readSection(DOC, { heading: 'Beta' })).toEqual({
      text: ['## Beta', 'beta body 1', 'beta body 2', '### Beta child', 'child body'].join('\n'),
      startLine: 7, endLine: 11,
    })
  })
  it('returns a line window for offset+limit', () => {
    expect(readSection(DOC, { offset: 4, limit: 2 })).toEqual({
      text: ['## Alpha', 'alpha body'].join('\n'), startLine: 4, endLine: 5,
    })
  })
  it('passes through a findSection error', () => {
    expect(readSection(DOC, { heading: 'Nope' })).toEqual({ error: 'heading_not_found', message: 'heading not found: "Nope"' })
  })
})

describe('documentStats', () => {
  it('counts lines and chars', () => {
    expect(documentStats('a\nb')).toEqual({ lineCount: 2, charCount: 3 })
  })
})

describe('grepContent', () => {
  it('finds substring matches with context', () => {
    const r = grepContent(DOC, 'beta body 1', { context: 1 })
    expect(r).toMatchObject({ total: 1, truncated: false })
    expect('error' in r).toBe(false)
    if ('matches' in r) {
      expect(r.matches[0]).toEqual({
        line: 8, text: 'beta body 1',
        context: [{ line: 7, text: '## Beta' }, { line: 9, text: 'beta body 2' }],
      })
    }
  })
  it('supports regex and caps at max', () => {
    const r = grepContent(DOC, '^## ', { regex: true, context: 0, max: 2 })
    expect(r).toMatchObject({ total: 3, truncated: true })
    expect('error' in r).toBe(false)
    if ('matches' in r) expect(r.matches.map(m => m.line)).toEqual([4, 7])
  })
  it('returns an error for an invalid regex instead of throwing', () => {
    const r = grepContent(DOC, '(', { regex: true })
    expect('error' in r).toBe(true)
  })
})

describe('applyReplace', () => {
  it('replaces a unique occurrence and reports one replacement', () => {
    expect(applyReplace('a foo b', 'foo', 'bar')).toEqual({ content: 'a bar b', replacements: 1 })
  })
  it('reports a typed no_match with a zero count when old_string is absent', () => {
    expect(applyReplace('abc', 'zzz', 'x')).toEqual({
      error: 'no_match',
      message: 'old_string not found in document',
      matches: 0,
    })
  })
  it('reports a typed ambiguous_match with the count and candidate lines', () => {
    const doc = ['alpha TODO', 'beta', 'gamma TODO', 'delta TODO'].join('\n')
    expect(applyReplace(doc, 'TODO', 'DONE')).toEqual({
      error: 'ambiguous_match',
      message: 'old_string is not unique (3 matches) — add surrounding context or pass replace_all',
      matches: 3,
      candidates: [
        { line: 1, text: 'alpha TODO' },
        { line: 3, text: 'gamma TODO' },
        { line: 4, text: 'delta TODO' },
      ],
    })
  })
  it('collapses several occurrences on one line into a single candidate', () => {
    const r = applyReplace('x x x', 'x', 'y') as { matches: number, candidates: unknown[] }
    expect(r.matches).toBe(3)
    expect(r.candidates).toEqual([{ line: 1, text: 'x x x' }])
  })
  it('caps candidates so a pervasive old_string cannot flood the response', () => {
    const doc = Array.from({ length: 40 }, (_, i) => `line ${i} TODO`).join('\n')
    const r = applyReplace(doc, 'TODO', 'DONE') as { matches: number, candidates: unknown[] }
    expect(r.matches).toBe(40)
    expect(r.candidates).toHaveLength(10)
  })
  it('truncates candidate text so one very long line cannot blow up the response', () => {
    const r = applyReplace('x'.repeat(5000), 'x', 'y') as { candidates: { text: string }[] }
    expect(r.candidates[0]!.text.length).toBeLessThanOrEqual(203) // 200 + the ellipsis
    expect(r.candidates[0]!.text.endsWith('…')).toBe(true)
  })
  it('leaves a short candidate line untouched', () => {
    const r = applyReplace('a TODO\nb TODO', 'TODO', 'x') as { candidates: { text: string }[] }
    expect(r.candidates[0]!.text).toBe('a TODO')
  })
  it('rejects an empty old_string with a typed error', () => {
    expect(applyReplace('abc', '', 'x')).toEqual({
      error: 'empty_old_string',
      message: 'old_string must not be empty',
      matches: 0,
    })
  })
  it('replaces all occurrences with replace_all and reports the count', () => {
    expect(applyReplace('x x x', 'x', 'y', true)).toEqual({ content: 'y y y', replacements: 3 })
  })
  it('treats $ in new_string literally (no regex specials)', () => {
    expect(applyReplace('cost is HERE', 'HERE', '$5')).toEqual({ content: 'cost is $5', replacements: 1 })
  })
})

describe('applyEditSection', () => {
  const DOC = ['# T', 'intro', '', '## A', 'a body', '', '## B', 'b body'].join('\n')
  it('appends to the end of the document (no heading)', () => {
    const r = applyEditSection(DOC, { mode: 'append', text: 'NEW' })
    expect(r).toEqual({ content: DOC.replace(/\n*$/, '') + '\n\nNEW\n' })
  })
  it('replaces a section body, keeping the heading', () => {
    const r = applyEditSection(DOC, { mode: 'replace', heading: 'A', text: 'fresh a' })
    if ('error' in r) throw new Error(r.error)
    expect(r.content).toBe(['# T', 'intro', '', '## A', 'fresh a', '## B', 'b body'].join('\n'))
  })
  it('appends inside a section, before the next heading', () => {
    const r = applyEditSection(DOC, { mode: 'append', heading: 'A', text: 'more a' })
    if ('error' in r) throw new Error(r.error)
    expect(r.content).toBe(['# T', 'intro', '', '## A', 'a body', '', 'more a', '## B', 'b body'].join('\n'))
  })
  it('errors on replace with no heading', () => {
    expect(applyEditSection(DOC, { mode: 'replace', text: 'x' })).toEqual({
      error: 'replace_needs_heading',
      message: 'replace mode requires a heading; use update_document to replace whole content',
    })
  })
  it('passes through a missing-heading error', () => {
    expect(applyEditSection(DOC, { mode: 'replace', heading: 'Z', text: 'x' })).toEqual({ error: 'heading_not_found', message: 'heading not found: "Z"' })
  })
})

describe('clipOutline', () => {
  it('caps a large outline and flags it', () => {
    const content = Array.from({ length: 80 }, (_, i) => `# H${i}`).join('\n\n')
    const r = clipOutline(content)
    expect(r.outline).toHaveLength(MAX_ERROR_OUTLINE)
    expect(r.outlineTruncated).toBe(true)
  })

  it('leaves a small outline whole and unflagged', () => {
    const r = clipOutline('# A\n\n# B')
    expect(r.outline).toHaveLength(2)
    expect(r.outlineTruncated).toBe(false)
  })
})

describe('grepContent hint', () => {
  it('suggests regex:true when a 0-match pattern looks like a regex', () => {
    const r = grepContent('plain text', 'foo.*bar', {}) as { total: number; hint?: string }
    expect(r.total).toBe(0)
    expect(r.hint).toMatch(/regex: true/)
  })

  it('stays silent when the pattern has no metacharacters', () => {
    const r = grepContent('plain text', 'zebra', {}) as { hint?: string }
    expect(r.hint).toBeUndefined()
  })

  it('stays silent when regex was already requested', () => {
    const r = grepContent('plain text', 'foo.*bar', { regex: true }) as { hint?: string }
    expect(r.hint).toBeUndefined()
  })

  it('stays silent when there are matches', () => {
    const r = grepContent('xx foo.*bar yy', 'foo.*bar', {}) as { hint?: string }
    expect(r.hint).toBeUndefined()
  })
})

describe('typed error codes', () => {
  it('findSection reports heading_not_found with the prose in message', () => {
    const r = findSection('# A\n\ntext', 'Missing') as { error: string; message: string }
    expect(r.error).toBe('heading_not_found')
    expect(r.message).toBe('heading not found: "Missing"')
  })

  it('findSection reports ambiguous_heading and names the count', () => {
    const r = findSection('# Dup\n\na\n\n# Dup\n\nb', 'Dup') as { error: string; message: string }
    expect(r.error).toBe('ambiguous_heading')
    expect(r.message).toMatch(/2 matches/)
  })

  it('grepContent reports invalid_regex', () => {
    const r = grepContent('body', '([', { regex: true }) as { error: string; message: string }
    expect(r.error).toBe('invalid_regex')
    expect(r.message).toMatch(/invalid regex/)
  })

  it('applyEditSection reports replace_needs_heading', () => {
    const r = applyEditSection('# A\n\nx', { mode: 'replace', text: 'y' }) as { error: string; message: string }
    expect(r.error).toBe('replace_needs_heading')
    expect(r.message).toMatch(/requires a heading/)
  })
})
