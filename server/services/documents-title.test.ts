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
})
