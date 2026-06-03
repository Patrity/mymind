import { describe, it, expect } from 'vitest'
import { wrap, toggleLinePrefix, setHeading, insertAt, makeLink } from '../shared/utils/md-transforms'
import type { Selection } from '../shared/utils/md-transforms'

// Helper: make a Selection from full text + a highlighted substring range
function sel(text: string, from: number, to: number): Selection {
  return { text, from, to }
}

// ---------------------------------------------------------------------------
// wrap
// ---------------------------------------------------------------------------
describe('wrap', () => {
  it('wraps non-empty selection with marker', () => {
    const s = sel('hello world', 6, 11) // "world"
    const result = wrap(s, '**')
    expect(result.text).toBe('hello **world**')
    // selection covers inner word
    expect(result.from).toBe(8)
    expect(result.to).toBe(13)
  })

  it('inserts double marker at cursor when selection is empty', () => {
    const s = sel('hello ', 6, 6)
    const result = wrap(s, '**')
    expect(result.text).toBe('hello ****')
    // cursor sits between the markers
    expect(result.from).toBe(8)
    expect(result.to).toBe(8)
  })

  it('wraps with backtick for inline code', () => {
    const s = sel('foo bar', 4, 7) // "bar"
    const result = wrap(s, '`')
    expect(result.text).toBe('foo `bar`')
    expect(result.from).toBe(5)
    expect(result.to).toBe(8)
  })

  it('wraps with single asterisk for italic', () => {
    const s = sel('text', 0, 4)
    const result = wrap(s, '*')
    expect(result.text).toBe('*text*')
    expect(result.from).toBe(1)
    expect(result.to).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// toggleLinePrefix
// ---------------------------------------------------------------------------
describe('toggleLinePrefix', () => {
  it('adds bullet prefix to a line', () => {
    const s = sel('hello world', 0, 11)
    const result = toggleLinePrefix(s, '- ')
    expect(result.text).toBe('- hello world')
  })

  it('removes bullet prefix when all lines have it', () => {
    const s = sel('- hello\n- world', 0, 15)
    const result = toggleLinePrefix(s, '- ')
    expect(result.text).toBe('hello\nworld')
  })

  it('adds prefix to multiple lines', () => {
    const s = sel('foo\nbar\nbaz', 0, 11)
    const result = toggleLinePrefix(s, '> ')
    expect(result.text).toBe('> foo\n> bar\n> baz')
  })

  it('adds prefix only when not all lines have it', () => {
    const s = sel('- foo\nbar', 0, 9)
    const result = toggleLinePrefix(s, '- ')
    expect(result.text).toBe('- - foo\n- bar')
  })

  it('removes numbered list prefix', () => {
    const s = sel('1. alpha\n1. beta', 0, 16)
    const result = toggleLinePrefix(s, '1. ')
    expect(result.text).toBe('alpha\nbeta')
  })

  it('adds checkbox list prefix', () => {
    const s = sel('task one', 0, 8)
    const result = toggleLinePrefix(s, '- [ ] ')
    expect(result.text).toBe('- [ ] task one')
  })

  it('toggle OFF with cursor at offset 0 returns non-negative from and to', () => {
    // Regression: toggling off a prefix when cursor is at offset 0 must not
    // produce a negative from/to (would cause a RangeError in CodeMirror).
    const s = sel('- foo', 0, 0)
    const result = toggleLinePrefix(s, '- ')
    expect(result.from).toBeGreaterThanOrEqual(0)
    expect(result.to).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// setHeading
// ---------------------------------------------------------------------------
describe('setHeading', () => {
  it('adds h1 to a plain line', () => {
    const s = sel('hello world', 0, 0)
    const result = setHeading(s, 1)
    expect(result.text).toBe('# hello world')
  })

  it('adds h2 to a plain line', () => {
    const s = sel('hello', 0, 0)
    const result = setHeading(s, 2)
    expect(result.text).toBe('## hello')
  })

  it('replaces h1 with h3', () => {
    const s = sel('# My Title', 0, 0)
    const result = setHeading(s, 3)
    expect(result.text).toBe('### My Title')
  })

  it('removes heading when level is 0', () => {
    const s = sel('## Section', 0, 0)
    const result = setHeading(s, 0)
    expect(result.text).toBe('Section')
  })

  it('operates on the correct line in multi-line text', () => {
    const full = 'first line\nsecond line\nthird line'
    const s = sel(full, 11, 11) // cursor on "second line"
    const result = setHeading(s, 2)
    expect(result.text).toBe('first line\n## second line\nthird line')
  })
})

// ---------------------------------------------------------------------------
// insertAt
// ---------------------------------------------------------------------------
describe('insertAt', () => {
  it('replaces selection with snippet', () => {
    const s = sel('hello world', 6, 11)
    const result = insertAt(s, 'there')
    expect(result.text).toBe('hello there')
    expect(result.from).toBe(11)
    expect(result.to).toBe(11)
  })

  it('inserts at cursor when selection is empty', () => {
    const s = sel('ab', 1, 1)
    const result = insertAt(s, 'X')
    expect(result.text).toBe('aXb')
    expect(result.from).toBe(2)
  })

  it('inserts code block snippet', () => {
    const snippet = '\n```\n\n```\n'
    const s = sel('', 0, 0)
    const result = insertAt(s, snippet)
    expect(result.text).toBe(snippet)
    expect(result.from).toBe(snippet.length)
  })
})

// ---------------------------------------------------------------------------
// makeLink
// ---------------------------------------------------------------------------
describe('makeLink', () => {
  it('wraps selected text as a link with cursor on url placeholder', () => {
    const s = sel('click here', 6, 10) // "here"
    const result = makeLink(s)
    expect(result.text).toBe('click [here](url)')
    // cursor should select "url"
    expect(result.from).toBe(13)
    expect(result.to).toBe(16)
  })

  it('inserts empty link when no selection', () => {
    const s = sel('', 0, 0)
    const result = makeLink(s)
    expect(result.text).toBe('[](url)')
    expect(result.from).toBe(3)
    expect(result.to).toBe(6)
  })
})
