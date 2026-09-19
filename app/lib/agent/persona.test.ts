import { describe, it, expect, vi } from 'vitest'
import { personaState, personaVariant, resetPersonaFallbackWarning, warnPersonaFallbackOnce } from './persona'

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
  it('passes known (offered) variants through', () => {
    expect(personaVariant('mana')).toBe('mana')
    expect(personaVariant('opal')).toBe('opal')
    expect(personaVariant('glint')).toBe('glint')
  })
  it('normalizes halo and command to obsidian — both render blank (white-on-white) in light mode', () => {
    expect(personaVariant('halo')).toBe('obsidian')
    expect(personaVariant('command')).toBe('obsidian')
  })
  it('defaults anything else unknown to obsidian', () => {
    expect(personaVariant('nope')).toBe('obsidian')
    expect(personaVariant(undefined)).toBe('obsidian')
  })
})
describe('warnPersonaFallbackOnce', () => {
  it('warns once per page load, not once per call/instance', () => {
    resetPersonaFallbackWarning()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnPersonaFallbackOnce(new Error('a'))
    warnPersonaFallbackOnce(new Error('b'))
    warnPersonaFallbackOnce(new Error('c'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('[persona] falling back:', expect.any(Error))
    spy.mockRestore()
  })
})
