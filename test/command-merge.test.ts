import { describe, it, expect } from 'vitest'
import { mergeCommands } from '../server/lib/commands/merge'
import type { CommandEntry } from '../shared/types/commands'

const e = (name: string, kind: CommandEntry['kind'], over: Partial<CommandEntry> = {}): CommandEntry =>
  ({ name, description: `${name} desc`, kind, ...over })

describe('mergeCommands', () => {
  it('returns all three sources when nothing collides', () => {
    const out = mergeCommands({
      client: [e('clear', 'client')],
      prompt: [e('standup', 'prompt')],
      skill: [e('browser-testing', 'skill')]
    })
    expect(out.map(c => c.name).sort()).toEqual(['browser-testing', 'clear', 'standup'])
  })

  it('lets code win over prompt and skill on the same name', () => {
    const out = mergeCommands({
      client: [e('clear', 'client')],
      prompt: [e('clear', 'prompt')],
      skill: [e('clear', 'skill')]
    })
    const clear = out.filter(c => c.name === 'clear')
    expect(clear).toHaveLength(1)
    expect(clear[0]!.kind).toBe('client')
  })

  it('lets prompt win over skill', () => {
    const out = mergeCommands({ client: [], prompt: [e('notes', 'prompt')], skill: [e('notes', 'skill')] })
    expect(out.find(c => c.name === 'notes')!.kind).toBe('prompt')
  })

  it('names the DISPLACED source on the winner, rather than dropping it silently', () => {
    // A shadowed skill that just vanished would be unexplainable from the UI.
    const out = mergeCommands({ client: [e('clear', 'client')], prompt: [], skill: [e('clear', 'skill')] })
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('client')
    expect(out[0]!.shadows).toEqual(['skill'])
  })

  it('records EVERY displaced source, not just the first', () => {
    const out = mergeCommands({ client: [e('x', 'client')], prompt: [e('x', 'prompt')], skill: [e('x', 'skill')] })
    expect(out[0]!.shadows).toEqual(['prompt', 'skill'])
  })

  it('does not set shadows when there is no collision', () => {
    const out = mergeCommands({ client: [e('clear', 'client')], prompt: [], skill: [e('browser-testing', 'skill')] })
    for (const c of out) expect(c.shadows).toBeUndefined()
  })

  it('sorts alphabetically so menu order is stable between fetches', () => {
    const out = mergeCommands({ client: [e('new', 'client')], prompt: [e('abc', 'prompt')], skill: [e('zed', 'skill')] })
    expect(out.map(c => c.name)).toEqual(['abc', 'new', 'zed'])
  })

  it('carries a prompt template through untouched', () => {
    const out = mergeCommands({ client: [], prompt: [e('standup', 'prompt', { template: 'What did I ship?' })], skill: [] })
    expect(out[0]!.template).toBe('What did I ship?')
  })

  it('keeps the first entry when one source has the same name twice', () => {
    const out = mergeCommands({
      client: [],
      prompt: [],
      skill: [e('dupe', 'skill', { description: 'first' }), e('dupe', 'skill', { description: 'second' })]
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.description).toBe('first')
  })

  it('never lists a source as shadowing itself', () => {
    const out = mergeCommands({
      client: [],
      prompt: [],
      skill: [e('dupe', 'skill'), e('dupe', 'skill')]
    })
    expect(out[0]!.shadows).toBeUndefined()
  })
})
