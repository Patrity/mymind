import { describe, it, expect } from 'vitest'
import { CLIENT_COMMANDS } from '../shared/types/commands'
import { commandsOrFallback } from '../app/composables/useCommands'

describe('commandsOrFallback', () => {
  it('returns fetched commands when the request succeeded', () => {
    const fetched = [{ name: 'browser-testing', description: 'd', kind: 'skill' as const }]
    expect(commandsOrFallback(fetched, false)).toEqual(fetched)
  })

  it('falls back to the code-defined commands on error', () => {
    // A server error must never cost you /clear.
    expect(commandsOrFallback(undefined, true)).toEqual(CLIENT_COMMANDS)
  })

  it('falls back when the fetch returned nothing yet', () => {
    expect(commandsOrFallback(undefined, false)).toEqual(CLIENT_COMMANDS)
  })

  it('does not fall back for a legitimately empty list', () => {
    // An empty array means "no commands", which is different from "not loaded".
    expect(commandsOrFallback([], false)).toEqual([])
  })
})
