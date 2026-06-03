import { describe, it, expect } from 'vitest'
import { slugify } from '../shared/utils/slugify'

describe('slugify', () => {
  it('"My Project!" → "my-project"', () => {
    expect(slugify('My Project!')).toBe('my-project')
  })

  it('"  a  b  " → "a-b"', () => {
    expect(slugify('  a  b  ')).toBe('a-b')
  })

  it('"C++ & Rust" → "c-rust"', () => {
    expect(slugify('C++ & Rust')).toBe('c-rust')
  })

  it('empty string → ""', () => {
    expect(slugify('')).toBe('')
  })

  it('only special chars → ""', () => {
    expect(slugify('!@#$%^&*()')).toBe('')
  })

  it('already-valid slug is unchanged', () => {
    expect(slugify('my-project')).toBe('my-project')
  })

  it('leading/trailing hyphens stripped', () => {
    expect(slugify('-hello-world-')).toBe('hello-world')
  })

  it('consecutive non-alphanumeric runs collapse to one hyphen', () => {
    expect(slugify('a---b')).toBe('a-b')
  })
})
