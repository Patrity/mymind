import { describe, it, expect } from 'vitest'
import {
  normalizePrefix, basenameOf, isUnderPrefix, longestPrefixMatch, isAutoCreatable,
  shouldRecordLocalPath, collapseLocalPaths
} from '../server/lib/projects/path-routing'

describe('normalizePrefix', () => {
  it('strips trailing slashes and trims; preserves root', () => {
    expect(normalizePrefix('/a/b/')).toBe('/a/b')
    expect(normalizePrefix('  /a/b  ')).toBe('/a/b')
    expect(normalizePrefix('/')).toBe('/')
    expect(normalizePrefix('')).toBe('')
  })
})

describe('basenameOf', () => {
  it('returns the last non-empty segment', () => {
    expect(basenameOf('/Users/tony/Documents/Projects/Terawulf')).toBe('Terawulf')
    expect(basenameOf('/a/b/BOM Schedules')).toBe('BOM Schedules')
    expect(basenameOf('/')).toBe('')
  })
})

describe('isUnderPrefix', () => {
  it('matches equal and descendant paths, not siblings or partial segments', () => {
    expect(isUnderPrefix('/p/Terawulf', '/p/Terawulf')).toBe(true)
    expect(isUnderPrefix('/p/Terawulf/MTO/Piping', '/p/Terawulf')).toBe(true)
    expect(isUnderPrefix('/p/Terawulf', '/p/Terawulf/MTO')).toBe(false) // parent is not under child
    expect(isUnderPrefix('/p/Terawulf2', '/p/Terawulf')).toBe(false)    // sibling, partial segment
    expect(isUnderPrefix('/p/a/b', '/p/a/')).toBe(true)                  // trailing slash tolerated
  })
})

describe('longestPrefixMatch', () => {
  const cands = [
    { id: '1', slug: 'terawulf', prefixes: ['/p/Terawulf'] },
    { id: '2', slug: 'mto', prefixes: ['/p/Terawulf/MTO'] }
  ]
  it('returns the longest ancestor-or-equal match', () => {
    expect(longestPrefixMatch('/p/Terawulf/MTO/Piping', cands)?.slug).toBe('mto')
    expect(longestPrefixMatch('/p/Terawulf/BOM Schedules', cands)?.slug).toBe('terawulf')
  })
  it('returns null when nothing matches', () => {
    expect(longestPrefixMatch('/other/place', cands)).toBeNull()
  })
})

describe('isAutoCreatable', () => {
  it('rejects home roots, temp, and generic container leaves', () => {
    expect(isAutoCreatable('/Users/tony')).toBe(false)
    expect(isAutoCreatable('/home/tony')).toBe(false)
    expect(isAutoCreatable('/mnt/c/Users/tonyc')).toBe(false)
    expect(isAutoCreatable('/tmp')).toBe(false)
    expect(isAutoCreatable('/tmp/scratch')).toBe(false)
    expect(isAutoCreatable('/Users/tony/Documents/GitHub')).toBe(false) // generic leaf 'github'
    expect(isAutoCreatable(null)).toBe(false)
    expect(isAutoCreatable('/')).toBe(false)
  })
  it('accepts real project folders', () => {
    expect(isAutoCreatable('/mnt/c/Users/tonyc/Documents/Projects/Terawulf')).toBe(true)
    expect(isAutoCreatable('/Users/tony/Documents/GitHub/mymind')).toBe(true)
  })
})

describe('shouldRecordLocalPath', () => {
  const PREFIX = ['/Users/tony/x/terawulf']

  it('records a genuinely new path', () => {
    expect(shouldRecordLocalPath('/Users/tony/other', [], [])).toBe(true)
  })
  it('skips an exact duplicate (existing behaviour)', () => {
    expect(shouldRecordLocalPath('/a/b', ['/a/b'], [])).toBe(false)
  })
  it('skips a path already covered by a pathPrefix', () => {
    expect(shouldRecordLocalPath('/Users/tony/x/terawulf/apps/web', [], PREFIX)).toBe(false)
  })
  it('skips a path under an existing localPath', () => {
    expect(shouldRecordLocalPath('/a/b/c', ['/a/b'], [])).toBe(false)
  })
  it('records a sibling that no prefix covers', () => {
    expect(shouldRecordLocalPath('/Users/tony/x/terawulf-old', [], PREFIX)).toBe(true)
  })
  it('normalises trailing slashes on both sides', () => {
    expect(shouldRecordLocalPath('/a/b/', ['/a/b'], [])).toBe(false)
    expect(shouldRecordLocalPath('/a/b/c', ['/a/b/'], [])).toBe(false)
  })
  it('records when cwd is a PARENT of an existing path', () => {
    expect(shouldRecordLocalPath('/a', ['/a/b'], [])).toBe(true)
  })
  it('records when cwd is a PARENT of a registered pathPrefix', () => {
    expect(shouldRecordLocalPath('/Users/tony/x', [], ['/Users/tony/x/terawulf'])).toBe(true)
  })
})

describe('collapseLocalPaths', () => {
  it('drops entries covered by a prefix', () => {
    expect(collapseLocalPaths(
      ['/t', '/t/apps', '/t/apps/web'], ['/t']
    )).toEqual([])
  })
  it('keeps the shortest ancestor when there is no prefix', () => {
    expect(collapseLocalPaths(['/t', '/t/apps', '/t/apps/web'], [])).toEqual(['/t'])
  })
  it('keeps unrelated siblings', () => {
    expect(collapseLocalPaths(['/a', '/b'], [])).toEqual(['/a', '/b'])
  })
  it('keeps a localPath that is an ANCESTOR of a registered prefix', () => {
    expect(collapseLocalPaths(['/Users/tony/x'], ['/Users/tony/x/terawulf'])).toEqual(['/Users/tony/x'])
  })
  it('is idempotent', () => {
    const once = collapseLocalPaths(['/t', '/t/apps'], [])
    expect(collapseLocalPaths(once, [])).toEqual(once)
  })
  it('returns an empty array unchanged', () => {
    expect(collapseLocalPaths([], [])).toEqual([])
  })
})
