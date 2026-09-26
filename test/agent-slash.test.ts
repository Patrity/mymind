import { describe, it, expect } from 'vitest'
import { shouldOpenMenu, menuQuery, parseCommand, applySelection, nextHighlight, shouldInterceptEnter, isMenuVisible, resolveSubmission } from '../app/lib/agent/slash'
import type { CommandEntry } from '../shared/types/commands'

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

describe('nextHighlight', () => {
  it('moves forward by one', () => {
    expect(nextHighlight(0, 3, 1)).toBe(1)
    expect(nextHighlight(1, 3, 1)).toBe(2)
  })

  it('wraps forward past the end back to the start', () => {
    expect(nextHighlight(2, 3, 1)).toBe(0)
  })

  it('moves backward by one', () => {
    expect(nextHighlight(2, 3, -1)).toBe(1)
  })

  it('wraps backward past the start back to the end', () => {
    expect(nextHighlight(0, 3, -1)).toBe(2)
  })

  it('stays at 0 for an empty list', () => {
    expect(nextHighlight(0, 0, 1)).toBe(0)
    expect(nextHighlight(0, 0, -1)).toBe(0)
  })
})

describe('shouldInterceptEnter', () => {
  it('intercepts a plain Enter when there are matches', () => {
    expect(shouldInterceptEnter({ key: 'Enter', shiftKey: false }, 3)).toBe(true)
  })

  it('does NOT intercept Shift+Enter even with matches — that is a newline', () => {
    expect(shouldInterceptEnter({ key: 'Enter', shiftKey: true }, 3)).toBe(false)
  })

  it('does not intercept Enter when nothing matched — "/xyz" must still submit', () => {
    expect(shouldInterceptEnter({ key: 'Enter', shiftKey: false }, 0)).toBe(false)
  })

  it('does not intercept Shift+Enter with no matches either', () => {
    expect(shouldInterceptEnter({ key: 'Enter', shiftKey: true }, 0)).toBe(false)
  })

  it('does not intercept a non-Enter key', () => {
    expect(shouldInterceptEnter({ key: 'ArrowDown', shiftKey: false }, 3)).toBe(false)
  })
})

describe('isMenuVisible', () => {
  it('is visible only when the menu is open AND something matched', () => {
    expect(isMenuVisible(true, 3)).toBe(true)
    expect(isMenuVisible(false, 3)).toBe(false)
  })

  it('is NOT visible when the menu is open with zero matches', () => {
    // "/zzz": the list renders nothing, so the keyboard handler must not swallow
    // ArrowUp/ArrowDown/Escape against an invisible menu.
    expect(isMenuVisible(true, 0)).toBe(false)
  })
})

// The composer's three-way dispatch — the heart of the cycle, and untested until now.
describe('resolveSubmission', () => {
  const client: CommandEntry = { name: 'clear', kind: 'client', description: 'Clear this conversation' }
  const macro: CommandEntry = { name: 'standup', kind: 'prompt', description: 'Standup', template: 'What did I ship?' }
  const skill: CommandEntry = { name: 'browser-testing', kind: 'skill', description: 'Browser testing' }
  const cmd = (text: string) => parseCommand(text)

  it('routes a client command to the page and sends no turn', () => {
    const r = resolveSubmission('/clear', cmd('/clear'), client)
    expect(r).toEqual({ text: '', clientCommand: 'clear' })
    expect(r.skillName).toBeUndefined()
  })

  it('expands a prompt macro and appends the arguments', () => {
    const r = resolveSubmission('/standup and the blockers', cmd('/standup and the blockers'), macro)
    expect(r).toEqual({ text: 'What did I ship?\n\nand the blockers' })
  })

  it('sends the bare template when a prompt macro has no arguments', () => {
    expect(resolveSubmission('/standup', cmd('/standup'), macro)).toEqual({ text: 'What did I ship?' })
  })

  it('sends a skill invocation VERBATIM, slash and all, naming the skill alongside', () => {
    // The command must survive into the turn: the transcript, a fork/edit replay, and the
    // model reading its own history all need to see that a slash command was used. An
    // earlier version sent only the arguments, which erased it.
    const r = resolveSubmission('/browser-testing validate the review page', cmd('/browser-testing validate the review page'), skill)
    expect(r).toEqual({ text: '/browser-testing validate the review page', skillName: 'browser-testing' })
  })

  it('sends the bare command for a skill with NO arguments', () => {
    // Two earlier shapes were wrong here: empty text tripped onSubmit's `!text` guard AFTER
    // submitForm had cleared the box (nothing sent, input eaten), and substituting
    // "Use the <name> skill." fixed that but erased the command from the transcript.
    const r = resolveSubmission('/browser-testing', cmd('/browser-testing'), skill)
    expect(r).toEqual({ text: '/browser-testing', skillName: 'browser-testing' })
  })

  it('falls through as ordinary text when the name matches no entry', () => {
    expect(resolveSubmission('/zzz hello', cmd('/zzz hello'), undefined)).toEqual({ text: '/zzz hello' })
  })

  it('leaves ordinary text alone', () => {
    expect(resolveSubmission('what did I ship?', null, undefined)).toEqual({ text: 'what did I ship?' })
  })

  it('degrades a prompt macro with an empty template to plain text, not to nothing', () => {
    const empty: CommandEntry = { ...macro, template: '' }
    expect(resolveSubmission('/standup', cmd('/standup'), empty)).toEqual({ text: '/standup' })
  })
})
