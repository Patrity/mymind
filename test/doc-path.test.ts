import { describe, it, expect } from 'vitest'
import { projectFromPath, rewriteProjectPathPrefix, PROJECTS_ROOT } from '../server/lib/projects/doc-path'

describe('PROJECTS_ROOT', () => {
  it('equals /projects', () => {
    expect(PROJECTS_ROOT).toBe('/projects')
  })
})

describe('projectFromPath', () => {
  it('returns the project segment for a path under /projects/<seg>/', () => {
    expect(projectFromPath('/projects/mymind/notes/a.md')).toBe('mymind')
  })

  it('returns the segment for a direct child file under /projects/<seg>/', () => {
    expect(projectFromPath('/projects/my-app/README.md')).toBe('my-app')
  })

  it('returns null when there is no trailing slash boundary (path stops at segment)', () => {
    expect(projectFromPath('/projects/mymind')).toBeNull()
  })

  it('returns null when path is not under /projects/', () => {
    expect(projectFromPath('/input/a.md')).toBeNull()
  })

  it('returns null when path starts with /projectsfoo/ (no false prefix match)', () => {
    expect(projectFromPath('/projectsfoo/a.md')).toBeNull()
  })

  it('returns null when the segment is empty (/projects//a.md)', () => {
    expect(projectFromPath('/projects//a.md')).toBeNull()
  })

  it('returns null for root path', () => {
    expect(projectFromPath('/')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(projectFromPath('')).toBeNull()
  })

  it('handles deeply nested paths correctly', () => {
    expect(projectFromPath('/projects/my-proj/sub/dir/file.ts')).toBe('my-proj')
  })
})

// ---------------------------------------------------------------------------
// rewriteProjectPathPrefix
// ---------------------------------------------------------------------------
describe('rewriteProjectPathPrefix', () => {
  it('rewrites /projects/<oldSlug>/ prefix to /projects/<newSlug>/', () => {
    expect(rewriteProjectPathPrefix('/projects/old/a/b.md', 'old', 'new')).toBe('/projects/new/a/b.md')
  })

  it('rewrites a direct child (no subdirectory)', () => {
    expect(rewriteProjectPathPrefix('/projects/my-proj/README.md', 'my-proj', 'renamed-proj')).toBe('/projects/renamed-proj/README.md')
  })

  it('leaves a path under a DIFFERENT project unchanged', () => {
    expect(rewriteProjectPathPrefix('/projects/other/file.md', 'old', 'new')).toBe('/projects/other/file.md')
  })

  it('leaves an /input path unchanged', () => {
    expect(rewriteProjectPathPrefix('/input/x.md', 'old', 'new')).toBe('/input/x.md')
  })

  it('does NOT rewrite /projects/<oldSlug>foo/... (no slash boundary)', () => {
    expect(rewriteProjectPathPrefix('/projects/oldfoo/x.md', 'old', 'new')).toBe('/projects/oldfoo/x.md')
  })

  it('does NOT rewrite bare /projects/<oldSlug> without trailing slash', () => {
    expect(rewriteProjectPathPrefix('/projects/old', 'old', 'new')).toBe('/projects/old')
  })

  it('rewrites deeply nested paths preserving subpath', () => {
    expect(rewriteProjectPathPrefix('/projects/alpha/sub/dir/note.md', 'alpha', 'beta')).toBe('/projects/beta/sub/dir/note.md')
  })
})
