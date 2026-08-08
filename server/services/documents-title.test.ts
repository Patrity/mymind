import { describe, it, expect } from 'vitest'
import { nextTitleOnMove } from './documents'

describe('nextTitleOnMove', () => {
  it('re-syncs a title that was tracking the filename', () => {
    expect(nextTitleOnMove({ currentTitle: 'mcp.md', currentPath: '/docs/mcp.md', finalPath: '/projects/x/guide.md' })).toBe('guide.md')
  })

  it('leaves a curated title alone', () => {
    expect(nextTitleOnMove({ currentTitle: 'MCP Server', currentPath: '/docs/mcp.md', finalPath: '/projects/x/guide.md' })).toBeUndefined()
  })

  it('an explicit title always wins', () => {
    expect(nextTitleOnMove({ explicit: 'Chosen', currentTitle: 'mcp.md', currentPath: '/docs/mcp.md', finalPath: '/projects/x/guide.md' })).toBeUndefined()
  })

  it('treats a null title as auto', () => {
    expect(nextTitleOnMove({ currentTitle: null, currentPath: '/docs/mcp.md', finalPath: '/x/guide.md' })).toBe('guide.md')
  })

  it('an explicit null title wins too — it must not fall through to basename sync', () => {
    // currentTitle deliberately equals basenameOfPath(currentPath): this title IS auto-tracking,
    // so a `wasAuto` check alone would happily resync it to the new basename. Only an early,
    // non-truthiness `explicit !== undefined` check stops that — a `if (opts.explicit) return
    // undefined` regression is falsy on `null` and falls through, returning 'guide.md' instead
    // of undefined. This case is what motivated widening `explicit` to `string | null`.
    expect(nextTitleOnMove({
      explicit: null, currentTitle: 'mcp.md',
      currentPath: '/docs/mcp.md', finalPath: '/x/guide.md'
    })).toBeUndefined()
  })

  it('an explicit empty-string title wins too — it must not fall through to basename sync', () => {
    // Same shape as the null case above, but with '' — the other value a truthiness check
    // collapses.
    expect(nextTitleOnMove({
      explicit: '', currentTitle: 'mcp.md',
      currentPath: '/docs/mcp.md', finalPath: '/x/guide.md'
    })).toBeUndefined()
  })
})
