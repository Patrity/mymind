import { describe, it, expect } from 'vitest'
import { getLanguageFromPath } from '../shared/utils/languages'

describe('getLanguageFromPath', () => {
  it('maps known extensions', () => {
    expect(getLanguageFromPath('/input/notes.md')).toBe('markdown')
    expect(getLanguageFromPath('/x/data.json')).toBe('json')
    expect(getLanguageFromPath('/x/q.sql')).toBe('sql')
  })
  it('falls back to plaintext', () => {
    expect(getLanguageFromPath('/x/file.unknownext')).toBe('plaintext')
    expect(getLanguageFromPath('/x/noext')).toBe('plaintext')
  })
})
