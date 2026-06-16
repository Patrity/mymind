import { describe, it, expect } from 'vitest'
import type { MemoryRelationDTO } from '../shared/types/memory'

// Pure logic extracted from app/pages/memories.vue
function relationLabel(rel: MemoryRelationDTO): string {
  if (rel.type === 'supersedes') return rel.direction === 'outgoing' ? '→ supersedes' : '← superseded by'
  if (rel.type === 'contradicts') return '⚠ contradicts'
  if (rel.type === 'duplicate-of') return rel.direction === 'outgoing' ? '≈ duplicate of' : '≈ duplicate'
  return rel.type
}

function relationColor(rel: MemoryRelationDTO): 'warning' | 'error' | 'neutral' | 'info' {
  if (rel.type === 'supersedes') return rel.direction === 'outgoing' ? 'warning' : 'neutral'
  if (rel.type === 'contradicts') return 'error'
  return 'info'
}

const r = (type: string, direction: 'outgoing' | 'incoming'): MemoryRelationDTO => ({
  type,
  direction,
  otherId: 'abc',
  status: 'active'
})

describe('relationLabel', () => {
  it('outgoing supersedes → arrow label', () => {
    expect(relationLabel(r('supersedes', 'outgoing'))).toBe('→ supersedes')
  })
  it('incoming supersedes → superseded-by label', () => {
    expect(relationLabel(r('supersedes', 'incoming'))).toBe('← superseded by')
  })
  it('contradicts → warning label regardless of direction', () => {
    expect(relationLabel(r('contradicts', 'outgoing'))).toBe('⚠ contradicts')
    expect(relationLabel(r('contradicts', 'incoming'))).toBe('⚠ contradicts')
  })
  it('duplicate-of outgoing', () => {
    expect(relationLabel(r('duplicate-of', 'outgoing'))).toBe('≈ duplicate of')
    expect(relationLabel(r('duplicate-of', 'incoming'))).toBe('≈ duplicate')
  })
  it('unknown type falls back to type string', () => {
    expect(relationLabel(r('related', 'outgoing'))).toBe('related')
  })
})

describe('relationColor', () => {
  it('outgoing supersedes → warning', () => {
    expect(relationColor(r('supersedes', 'outgoing'))).toBe('warning')
  })
  it('incoming supersedes → neutral', () => {
    expect(relationColor(r('supersedes', 'incoming'))).toBe('neutral')
  })
  it('contradicts → error', () => {
    expect(relationColor(r('contradicts', 'outgoing'))).toBe('error')
  })
  it('other → info', () => {
    expect(relationColor(r('duplicate-of', 'outgoing'))).toBe('info')
  })
})
