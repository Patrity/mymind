import { describe, it, expect } from 'vitest'
import { shouldOpenMenu, menuQuery, parseCommand, applySelection } from '../app/lib/agent/slash'

describe('shouldOpenMenu', () => {
  it('opens on a leading slash', () => {
    expect(shouldOpenMenu('/')).toBe(true)
    expect(shouldOpenMenu('/br')).toBe(true)
  })

  it('does NOT open mid-text', () => {
    // Otherwise a file path or a date fires the menu.
    expect(shouldOpenMenu('see /etc/hosts')).toBe(false)
    expect(shouldOpenMenu('on 9/24')).toBe(false)
  })

  it('does not open on empty input', () => {
    expect(shouldOpenMenu('')).toBe(false)
  })

  it('closes once the command has an argument', () => {
    // The name is settled; the rest of the line is the prompt.
    expect(shouldOpenMenu('/browser-testing ')).toBe(false)
    expect(shouldOpenMenu('/browser-testing validate')).toBe(false)
  })

  it('does not open when the slash is preceded by whitespace only at the start', () => {
    expect(shouldOpenMenu(' /clear')).toBe(false)
  })
})

describe('menuQuery', () => {
  it('is the text after the slash', () => {
    expect(menuQuery('/bro')).toBe('bro')
  })

  it('is empty for a bare slash', () => {
    expect(menuQuery('/')).toBe('')
  })
})

describe('parseCommand', () => {
  it('splits name from arguments', () => {
    expect(parseCommand('/browser-testing validate the review page'))
      .toEqual({ name: 'browser-testing', args: 'validate the review page' })
  })

  it('returns empty args when there are none', () => {
    expect(parseCommand('/clear')).toEqual({ name: 'clear', args: '' })
  })

  it('tolerates trailing whitespace after the name', () => {
    expect(parseCommand('/clear   ')).toEqual({ name: 'clear', args: '' })
  })

  it('returns null for ordinary text', () => {
    expect(parseCommand('hello there')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })

  it('returns null for a bare slash with no name', () => {
    expect(parseCommand('/')).toBeNull()
  })
})

describe('applySelection', () => {
  it('produces the name plus a trailing space, ready for arguments', () => {
    expect(applySelection('browser-testing')).toBe('/browser-testing ')
  })
})
