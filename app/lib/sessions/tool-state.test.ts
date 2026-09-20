import { describe, it, expect } from 'vitest'
import { sessionToolState } from './tool-state'
import type { SessionToolEventDTO } from '~~/shared/types/session'

const base: SessionToolEventDTO = {
  id: 't1', messageId: 'm1', toolName: 'Bash', args: { command: 'ls' }, result: 'a\nb',
  exitStatus: null, phase: 'post', toolUseId: 'tu1', isSidechain: false,
  createdAt: '2026-09-19T00:00:00.000Z'
}

describe('sessionToolState', () => {
  it('maps a clean run to output-available', () => {
    expect(sessionToolState({ ...base, exitStatus: 'success' }))
      .toEqual({ state: 'output-available', input: { command: 'ls' }, output: 'a\nb' })
  })

  it('treats a null exitStatus as available, not as an error', () => {
    expect(sessionToolState(base).state).toBe('output-available')
  })

  it.each(['error', 'failure', 'failed', 'ERROR'])('maps %s to output-error', (s) => {
    expect(sessionToolState({ ...base, exitStatus: s }).state).toBe('output-error')
  })

  it('passes a non-string result through untouched for the renderer to format', () => {
    const result = { rows: [1, 2, 3] }
    expect(sessionToolState({ ...base, result }).output).toEqual(result)
  })

  it('survives a missing result', () => {
    expect(sessionToolState({ ...base, result: null }).output).toBeNull()
  })
})
