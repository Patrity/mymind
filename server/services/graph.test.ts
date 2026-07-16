import { describe, it, expect } from 'vitest'
import { assembleEdges } from './graph'

describe('assembleEdges', () => {
  it('builds membership, provenance, ocr, and relation edges; skips nulls', () => {
    const edges = assembleEdges({
      memberships: [{ type: 'memory', id: 'm1', projectId: 'p1' }, { type: 'image', id: 'i1', projectId: null }],
      provenance: [{ memoryId: 'm1', sessionId: 's1' }, { memoryId: 'm2', sessionId: null }],
      ocr: [{ documentId: 'd1', imageId: 'i1' }],
      relations: [{ fromId: 'm1', toId: 'm2', type: 'supersedes' }],
    })
    expect(edges).toContainEqual({ from: { type: 'memory', id: 'm1' }, to: { type: 'project', id: 'p1' }, kind: 'membership' })
    expect(edges).toContainEqual({ from: { type: 'memory', id: 'm1' }, to: { type: 'session', id: 's1' }, kind: 'provenance' })
    expect(edges).toContainEqual({ from: { type: 'document', id: 'd1' }, to: { type: 'image', id: 'i1' }, kind: 'ocr' })
    expect(edges).toContainEqual({ from: { type: 'memory', id: 'm1' }, to: { type: 'memory', id: 'm2' }, kind: 'supersedes' })
    // null projectId / sessionId produce no edge
    expect(edges.filter(e => e.kind === 'membership')).toHaveLength(1)
    expect(edges.filter(e => e.kind === 'provenance')).toHaveLength(1)
  })
})
