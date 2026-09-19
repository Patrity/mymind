import { describe, it, expect } from 'vitest'
import { personaState, personaVariant } from './persona'

describe('personaState', () => {
  it('maps voice states onto the five Persona states', () => {
    expect(personaState('idle', true)).toBe('idle')
    expect(personaState('listening', true)).toBe('listening')
    for (const s of ['thinking', 'tool', 'typing'] as const) expect(personaState(s, true)).toBe('thinking')
    expect(personaState('speaking', true)).toBe('speaking')
    expect(personaState('connecting', true)).toBe('asleep')
    expect(personaState('speaking', false)).toBe('asleep')
  })
})
describe('personaVariant', () => {
  it('passes known variants, defaults everything else to obsidian', () => {
    expect(personaVariant('halo')).toBe('halo')
    expect(personaVariant('nope')).toBe('obsidian')
    expect(personaVariant(undefined)).toBe('obsidian')
  })
})
