import { describe, it, expect, vi } from 'vitest'
import { routeSessionDocCandidates } from '../server/services/memory-enrich'

const C = [{ text: 'a', project: null, targetDocHint: null }, { text: 'b', project: 'p', targetDocHint: 'h' }]

describe('routeSessionDocCandidates', () => {
  it('drops every candidate when the session wrote its own docs', async () => {
    const file = vi.fn(async () => null)
    expect(await routeSessionDocCandidates('s1', C, { wroteDocs: async () => true, file })).toBe('skipped')
    await new Promise(r => setTimeout(r, 0))
    expect(file).not.toHaveBeenCalled()
  })

  it('files each candidate otherwise', async () => {
    const file = vi.fn(async () => null)
    expect(await routeSessionDocCandidates('s1', C, { wroteDocs: async () => false, file })).toBe('routed')
    await vi.waitFor(() => expect(file).toHaveBeenCalledTimes(2))
    expect(file).toHaveBeenCalledWith(C[0], { sessionId: 's1' })
  })

  it('routes anyway when the doc-write check fails', async () => {
    const file = vi.fn(async () => null)
    expect(await routeSessionDocCandidates('s1', C, { wroteDocs: async () => { throw new Error('db') }, file })).toBe('routed')
  })

  it('does nothing without candidates', async () => {
    const wroteDocs = vi.fn(async () => true)
    expect(await routeSessionDocCandidates('s1', [], { wroteDocs })).toBe('none')
    expect(wroteDocs).not.toHaveBeenCalled()
  })
})
