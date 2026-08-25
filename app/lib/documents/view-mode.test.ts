import { describe, it, expect } from 'vitest'
import { resolveViewMode } from './view-mode'

// The view mode is a year-long cookie (mm.documents.viewMode). Restoring it blindly meant
// opening a brand-new empty note in Preview — a blank pane with no visible way to type.
// The resolution is per-document and must NOT write back to the cookie, or opening one
// empty note would permanently reset a preference the user set deliberately.
describe('resolveViewMode', () => {
  it('forces edit when an empty markdown doc would open in preview', () => {
    expect(resolveViewMode('preview', { content: '', isMarkdown: true })).toBe('edit')
    expect(resolveViewMode('preview', { content: '   \n\t ', isMarkdown: true })).toBe('edit')
  })

  it('leaves split alone on an empty doc — half the pane is still an editor', () => {
    expect(resolveViewMode('split', { content: '', isMarkdown: true })).toBe('split')
  })

  it('keeps preview for a doc that actually has content', () => {
    expect(resolveViewMode('preview', { content: '# hi', isMarkdown: true })).toBe('preview')
  })

  it('forces edit for non-markdown regardless of stored mode', () => {
    expect(resolveViewMode('preview', { content: 'select 1', isMarkdown: false })).toBe('edit')
    expect(resolveViewMode('split', { content: 'select 1', isMarkdown: false })).toBe('edit')
  })

  it('passes edit through unchanged in every case', () => {
    expect(resolveViewMode('edit', { content: '', isMarkdown: true })).toBe('edit')
    expect(resolveViewMode('edit', { content: '# hi', isMarkdown: true })).toBe('edit')
  })
})
