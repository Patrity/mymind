import { describe, it, expect } from 'vitest'
import { projectFromPath, PROJECTS_ROOT } from '../server/lib/projects/doc-path'

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
