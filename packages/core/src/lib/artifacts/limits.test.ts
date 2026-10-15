import { describe, it, expect } from 'vitest'
import { normalizeArtifactPath, contentTypeFor, isTextPath, slugProblem, slugFromTitle, ArtifactError } from './limits'

describe('normalizeArtifactPath', () => {
  it.each([
    ['index.html', 'index.html'],
    ['./assets/app.js', 'assets/app.js'],
    ['assets//app.js', 'assets/app.js'],
    ['data/x.json', 'data/x.json']
  ])('%s → %s', (input, out) => expect(normalizeArtifactPath(input)).toBe(out))

  it.each(['', '/etc/passwd', '../x', 'a/../../x', 'a/..', 'a\\b.js', 'a\0b', '.', 'dir/'])(
    'rejects %j', (p) => {
      expect(() => normalizeArtifactPath(p)).toThrow(ArtifactError)
    })
})

describe('contentTypeFor', () => {
  it('maps allowlisted extensions case-insensitively', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('A/B.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('x.wasm')).toBe('application/wasm')
    expect(contentTypeFor('font.woff2')).toBe('font/woff2')
  })
  it('returns null for anything else', () => {
    expect(contentTypeFor('video.mov')).toBeNull()
    expect(contentTypeFor('Makefile')).toBeNull()
    expect(contentTypeFor('x.exe')).toBeNull()
  })
})

describe('isTextPath', () => {
  it('is true for maskable text types only', () => {
    expect(isTextPath('a.js')).toBe(true)
    expect(isTextPath('a.svg')).toBe(true)
    expect(isTextPath('a.png')).toBe(false)
  })
})

describe('slugs', () => {
  it('accepts valid slugs', () => expect(slugProblem('sales-q3')).toBeNull())
  it.each(['', '-a', 'a-', 'A', 'a_b', 'x'.repeat(65)])('rejects %j', s => expect(slugProblem(s)).not.toBeNull())
  it('derives from a title', () => {
    expect(slugFromTitle('Q3 Sales — Dashboard!')).toBe('q3-sales-dashboard')
    expect(slugFromTitle('!!!')).toBe('artifact')
    expect(slugFromTitle('x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
})
