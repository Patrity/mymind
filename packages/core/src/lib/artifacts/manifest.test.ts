import { describe, it, expect } from 'vitest'
import { mergeManifest, onlyDataChanged, validateManifest, lookupPath, manifestStats } from './manifest'
import { ArtifactError, type Manifest } from './limits'

const f = (sha: string, size = 10, contentType = 'text/html; charset=utf-8') => ({ key: `k/${sha}`, sha256: sha, size, contentType })
const base: Manifest = { 'index.html': f('a'), 'assets/app.js': f('b'), 'data/x.json': f('c') }

describe('mergeManifest', () => {
  it('replace mode returns next exactly', () => expect(mergeManifest(base, { 'index.html': f('z') }, false)).toEqual({ 'index.html': f('z') }))
  it('merge mode overlays', () => expect(mergeManifest(base, { 'data/x.json': f('d') }, true)).toEqual({ ...base, 'data/x.json': f('d') }))
  it('no previous → next', () => expect(mergeManifest(null, base, true)).toEqual(base))
})

describe('onlyDataChanged', () => {
  it('data change only → true', () => expect(onlyDataChanged(base, { ...base, 'data/x.json': f('d') })).toBe(true))
  it('new data file → true', () => expect(onlyDataChanged(base, { ...base, 'data/y.json': f('e') })).toBe(true))
  it('removing a data file → true', () => { const { 'data/x.json': _, ...rest } = base; expect(onlyDataChanged(base, rest)).toBe(true) })
  it('non-data change → false', () => expect(onlyDataChanged(base, { ...base, 'index.html': f('q'), 'data/x.json': f('d') })).toBe(false))
  it('identical → false', () => expect(onlyDataChanged(base, { ...base })).toBe(false))
  it('"database/x" is not a data path', () => expect(onlyDataChanged(base, { ...base, 'database/x.json': f('w') })).toBe(false))
})

describe('validateManifest', () => {
  it('passes a valid manifest', () => expect(() => validateManifest(base, 'index.html')).not.toThrow())
  it('missing entry', () => expect(() => validateManifest(base, 'main.html')).toThrow(/entry main.html not found/))
  it('too many files', () => {
    const m: Manifest = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.js`, f(String(i), 1)]))
    m['index.html'] = f('i')
    expect(() => validateManifest(m, 'index.html')).toThrow(ArtifactError)
  })
  it('too large in total', () => {
    const m: Manifest = { 'index.html': f('i'), 'a.png': f('p', 9 * 1024 * 1024), 'b.png': f('q', 9 * 1024 * 1024), 'c.png': f('r', 9 * 1024 * 1024) }
    expect(() => validateManifest(m, 'index.html')).toThrow(/25 MB/)
  })
  it('stats', () => expect(manifestStats(base)).toEqual({ files: 3, totalBytes: 30 }))
})

describe('lookupPath', () => {
  it('empty path → entry', () => expect(lookupPath(base, 'index.html', false, '')?.path).toBe('index.html'))
  it('exact hit', () => expect(lookupPath(base, 'index.html', false, 'assets/app.js')?.path).toBe('assets/app.js'))
  it('dir path with index.html inside', () => {
    const m = { ...base, 'docs/index.html': f('di') }
    expect(lookupPath(m, 'index.html', false, 'docs/')?.path).toBe('docs/index.html')
  })
  it('miss without fallback → null', () => expect(lookupPath(base, 'index.html', false, 'settings')).toBeNull())
  it('miss with fallback, no extension → entry', () => expect(lookupPath(base, 'index.html', true, 'settings/profile')?.path).toBe('index.html'))
  it('miss with fallback, has extension → null', () => expect(lookupPath(base, 'index.html', true, 'missing.js')).toBeNull())
  it('traversal-looking path → null, never throws', () => expect(lookupPath(base, 'index.html', true, '../secret')).toBeNull())
})
