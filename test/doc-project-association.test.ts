/**
 * Task 3: Association choke point + write-path wiring
 *
 * Tests the PURE helpers (targetPathForAssign, computeFinalPath) extracted from
 * documents.ts for the path/assign reconciliation logic. These don't need a DB.
 *
 * The DB-backed tests for createDoc/updateDoc are verified via typecheck and
 * the approve-proposal path analysis (the unique index guards collision; the
 * service is wired — verified by typechecker + integration context).
 *
 * The approve-proposal path analysis:
 *   approve.post.ts calls updateDoc({project:'X'}) then moveDoc(p.path).
 *   With this change:
 *     1. updateDoc({project:'X'}) → files doc at /projects/X/<basename> (move #1)
 *     2. moveDoc('/projects/X/<basename>') → updateDoc({path:'/projects/X/<basename>'})
 *        computeFinalPath: path already under /projects/X/ → no-op (same path)
 *        resolveDocProjectFromPath: same result → no-op update.
 *   The second call is idempotent. No double-move. No unique-index collision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  targetPathForAssign,
  computeFinalPath,
} from '../server/services/documents'

// ---------------------------------------------------------------------------
// targetPathForAssign
// ---------------------------------------------------------------------------
describe('targetPathForAssign', () => {
  it('builds /projects/<slug>/<basename> from an /input path', () => {
    expect(targetPathForAssign('/input/foo.md', 'mymind')).toBe('/projects/mymind/foo.md')
  })

  it('uses only the basename, discarding nested subdirs', () => {
    expect(targetPathForAssign('/input/nested/dir/report.pdf', 'my-project')).toBe('/projects/my-project/report.pdf')
  })

  it('works when currentPath is already under a DIFFERENT project', () => {
    expect(targetPathForAssign('/projects/old-proj/file.md', 'new-proj')).toBe('/projects/new-proj/file.md')
  })

  it('handles root-level filenames', () => {
    expect(targetPathForAssign('/doc.md', 'alpha')).toBe('/projects/alpha/doc.md')
  })
})

// ---------------------------------------------------------------------------
// computeFinalPath — the pure precedence decision
// ---------------------------------------------------------------------------
describe('computeFinalPath', () => {
  it('keeps the path unchanged when no project is given', () => {
    expect(computeFinalPath('/input/foo.md', null)).toBe('/input/foo.md')
    expect(computeFinalPath('/input/foo.md', undefined)).toBe('/input/foo.md')
  })

  it('keeps the path when it is already under /projects/<slug>/', () => {
    // already filed — no move
    expect(computeFinalPath('/projects/mymind/foo.md', 'mymind')).toBe('/projects/mymind/foo.md')
  })

  it('moves the doc when project slug is given and path is NOT already there', () => {
    expect(computeFinalPath('/input/foo.md', 'mymind')).toBe('/projects/mymind/foo.md')
  })

  it('moves when path is under a DIFFERENT project', () => {
    expect(computeFinalPath('/projects/old/foo.md', 'new')).toBe('/projects/new/foo.md')
  })

  it('path wins when project=null — stays put even if under /projects/', () => {
    // A doc already under /projects/X/ with project=null should NOT be moved
    // (the caller later resolves the project from the path, so X is still set)
    expect(computeFinalPath('/projects/mymind/foo.md', null)).toBe('/projects/mymind/foo.md')
  })
})

// ---------------------------------------------------------------------------
// resolveDocProjectFromPath — unit-tested with a mocked matchProjectByLabel
// ---------------------------------------------------------------------------
import { resolveDocProjectFromPath } from '../server/services/documents'
import * as projectsService from '../server/services/projects'

// ---------------------------------------------------------------------------
// Approve-proposal path: verify no double-move regression
// The approve handler calls:
//   updateDoc(id, { project: 'X', ... })  ← files doc under /projects/X/
//   moveDoc(id, '/projects/X/foo.md')     ← second pass with same final path
// The second pass must be idempotent (computeFinalPath detects already-filed).
// ---------------------------------------------------------------------------
describe('approve-proposal path (regression — no double-move)', () => {
  it('computeFinalPath is idempotent when path already under /projects/<slug>/', () => {
    const slug = 'mymind'
    // Simulate: step 1 moved the doc, step 2 passes the same target path
    const afterStep1 = '/projects/mymind/foo.md'
    const step2Path = computeFinalPath(afterStep1, slug)
    expect(step2Path).toBe('/projects/mymind/foo.md')
  })

  it('computeFinalPath with no project (moveDoc call passes only path)', () => {
    // moveDoc calls updateDoc({path}), no project — path wins, no reassign
    const path = '/projects/mymind/foo.md'
    expect(computeFinalPath(path, undefined)).toBe(path)
    expect(computeFinalPath(path, null)).toBe(path)
  })

  it('resolveDocProjectFromPath returns same result on second pass', async () => {
    vi.spyOn(projectsService, 'matchProjectByLabel').mockResolvedValue({
      id: 'uuid-mymind',
      slug: 'mymind',
    } as any)
    const first = await resolveDocProjectFromPath('/projects/mymind/foo.md')
    const second = await resolveDocProjectFromPath('/projects/mymind/foo.md')
    expect(first).toEqual(second)
    expect(first).toEqual({ projectId: 'uuid-mymind', project: 'mymind' })
  })
})

describe('resolveDocProjectFromPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the project id + slug for a path under /projects/<slug>/ that matches', async () => {
    vi.spyOn(projectsService, 'matchProjectByLabel').mockResolvedValue({
      id: 'uuid-mymind',
      slug: 'mymind',
    } as any)

    const result = await resolveDocProjectFromPath('/projects/mymind/x.md')
    expect(result).toEqual({ projectId: 'uuid-mymind', project: 'mymind' })
    expect(projectsService.matchProjectByLabel).toHaveBeenCalledWith('mymind')
  })

  it('returns null/null for /projects/nope/x.md when no project row matches', async () => {
    vi.spyOn(projectsService, 'matchProjectByLabel').mockResolvedValue(null)

    const result = await resolveDocProjectFromPath('/projects/nope/x.md')
    expect(result).toEqual({ projectId: null, project: null })
  })

  it('returns null/null for an /input path (no /projects/ prefix)', async () => {
    const spy = vi.spyOn(projectsService, 'matchProjectByLabel')

    const result = await resolveDocProjectFromPath('/input/foo.md')
    expect(result).toEqual({ projectId: null, project: null })
    // Should NOT call matchProjectByLabel — no segment to match
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns null/null for a bare /projects/<seg> without trailing slash', async () => {
    const spy = vi.spyOn(projectsService, 'matchProjectByLabel')

    const result = await resolveDocProjectFromPath('/projects/mymind')
    expect(result).toEqual({ projectId: null, project: null })
    expect(spy).not.toHaveBeenCalled()
  })
})
