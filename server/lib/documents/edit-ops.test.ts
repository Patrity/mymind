import { describe, it, expect } from 'vitest'
import { outline, findSection, readSection, documentStats, grepContent } from './edit-ops'

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
})

describe('findSection', () => {
  it('spans a section to the next same-or-higher heading', () => {
    // "Beta" (level 2) body runs line 7..9 — stops before its level-3 child? No: child is deeper, so it is INCLUDED. Next level<=2 is line 12.
    expect(findSection(DOC, 'Beta')).toEqual({ startLine: 7, endLine: 11, level: 2 })
  })
  it('errors when the heading is missing', () => {
    expect(findSection(DOC, 'Nope')).toEqual({ error: 'heading not found: "Nope"' })
  })
  it('errors when the heading is ambiguous', () => {
    expect(findSection(DOC, 'Alpha')).toEqual({ error: 'heading "Alpha" is ambiguous (2 matches)' })
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
    expect(readSection(DOC, { heading: 'Nope' })).toEqual({ error: 'heading not found: "Nope"' })
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
    if ('matches' in r) expect(r.matches.map(m => m.line)).toEqual([4, 7])
  })
  it('returns an error for an invalid regex instead of throwing', () => {
    const r = grepContent(DOC, '(', { regex: true })
    expect('error' in r).toBe(true)
  })
})
