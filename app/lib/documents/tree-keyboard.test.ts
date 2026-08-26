import { describe, it, expect } from 'vitest'
import {
  arrowLeftAction,
  arrowRightAction,
  folderChainOf,
  neighborPathFor,
  nextVisiblePath,
  typeaheadMatch
} from './tree-keyboard'

describe('nextVisiblePath', () => {
  const paths = ['/a', '/a/b', '/c']

  it('moves down to the next row', () => {
    expect(nextVisiblePath(paths, '/a', 'down')).toBe('/a/b')
  })

  it('moves up to the previous row', () => {
    expect(nextVisiblePath(paths, '/a/b', 'up')).toBe('/a')
  })

  it('is a no-op past the last row', () => {
    expect(nextVisiblePath(paths, '/c', 'down')).toBeNull()
  })

  it('is a no-op before the first row', () => {
    expect(nextVisiblePath(paths, '/a', 'up')).toBeNull()
  })

  it('returns null for a path that is not in the list at all', () => {
    expect(nextVisiblePath(paths, '/nowhere', 'down')).toBeNull()
  })
})

describe('arrowLeftAction', () => {
  it('collapses an expanded folder in place', () => {
    expect(arrowLeftAction({ nodeType: 'folder', expanded: true }, '/a')).toEqual({ type: 'collapse' })
  })

  it('moves to the parent for a collapsed folder', () => {
    expect(arrowLeftAction({ nodeType: 'folder', expanded: false }, '/a')).toEqual({ type: 'moveTo', path: '/a' })
  })

  it('moves to the parent for a file', () => {
    expect(arrowLeftAction({ nodeType: 'file', expanded: false }, '/a/b')).toEqual({ type: 'moveTo', path: '/a/b' })
  })

  it('is a no-op at the top level, where the parent is root and has no row', () => {
    expect(arrowLeftAction({ nodeType: 'file', expanded: false }, '/')).toEqual({ type: 'noop' })
    expect(arrowLeftAction({ nodeType: 'folder', expanded: false }, '/')).toEqual({ type: 'noop' })
  })
})

describe('arrowRightAction', () => {
  it('expands a collapsed folder in place, first child or not', () => {
    expect(arrowRightAction({ nodeType: 'folder', expanded: false }, '/a/b')).toEqual({ type: 'expand' })
    expect(arrowRightAction({ nodeType: 'folder', expanded: false }, null)).toEqual({ type: 'expand' })
  })

  it('moves to the first child of an already-expanded folder', () => {
    expect(arrowRightAction({ nodeType: 'folder', expanded: true }, '/a/b')).toEqual({ type: 'moveTo', path: '/a/b' })
  })

  it('is a no-op for an expanded folder with no children', () => {
    expect(arrowRightAction({ nodeType: 'folder', expanded: true }, null)).toEqual({ type: 'noop' })
  })

  it('is always a no-op for a file, expanded flag notwithstanding', () => {
    expect(arrowRightAction({ nodeType: 'file', expanded: false }, '/a/b')).toEqual({ type: 'noop' })
    expect(arrowRightAction({ nodeType: 'file', expanded: true }, '/a/b')).toEqual({ type: 'noop' })
  })
})

describe('typeaheadMatch', () => {
  const paths = ['/apple', '/banana', '/cherry', '/avocado']
  const labels: Record<string, string> = {
    '/apple': 'apple.md',
    '/banana': 'banana.md',
    '/cherry': 'cherry.md',
    '/avocado': 'avocado.md'
  }
  const labelOf = (p: string) => labels[p]

  it('matches the next row starting with the buffer, case-insensitively', () => {
    expect(typeaheadMatch(paths, labelOf, '/apple', 'B')).toBe('/banana')
  })

  it('wraps around the end of the list back to the start', () => {
    // Starting from the LAST row, the only "a…" match is back at the front of the list.
    expect(typeaheadMatch(paths, labelOf, '/avocado', 'a')).toBe('/apple')
  })

  it('skips the current row itself even when it matches — search starts one past it', () => {
    // From /apple, typing "a" must not just re-select /apple; it should wrap all the way to
    // the next "a…" row, which is /avocado.
    expect(typeaheadMatch(paths, labelOf, '/apple', 'a')).toBe('/avocado')
  })

  it('finds a multi-character buffer', () => {
    expect(typeaheadMatch(paths, labelOf, '/apple', 'cher')).toBe('/cherry')
  })

  it('returns null when nothing matches', () => {
    expect(typeaheadMatch(paths, labelOf, '/apple', 'zzz')).toBeNull()
  })

  it('returns null for an empty buffer', () => {
    expect(typeaheadMatch(paths, labelOf, '/apple', '')).toBeNull()
  })

  it('returns null when the current path is not in the list', () => {
    expect(typeaheadMatch(paths, labelOf, '/nowhere', 'a')).toBeNull()
  })

  it('returns null on an empty list', () => {
    expect(typeaheadMatch([], labelOf, '/apple', 'a')).toBeNull()
  })
})

describe('neighborPathFor', () => {
  it('prefers the previous sibling', () => {
    const siblings = ['/a', '/b', '/c']
    expect(neighborPathFor('/b', siblings, '/')).toBe('/a')
  })

  it('falls back to the next sibling when there is no previous one', () => {
    const siblings = ['/a', '/b', '/c']
    expect(neighborPathFor('/a', siblings, '/')).toBe('/b')
  })

  it('falls back to the parent when there are no siblings at all', () => {
    expect(neighborPathFor('/a/only-child', ['/a/only-child'], '/a')).toBe('/a')
  })

  it('returns null when the parent is root and there are no siblings', () => {
    expect(neighborPathFor('/only-top-level', ['/only-top-level'], '/')).toBeNull()
  })
})

describe('folderChainOf', () => {
  it('builds every ancestor down to the path itself, root-first', () => {
    expect(folderChainOf('/a/b/c')).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('returns a single-element chain for a top-level folder', () => {
    expect(folderChainOf('/a')).toEqual(['/a'])
  })
})
