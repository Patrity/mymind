// Final review I1: an idle pooled client's socket error must never crash the process. pg's Pool is
// an EventEmitter — an 'error' with no listener throws. No connection is made here (pg connects lazily).
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { useDb } from './index'

describe('useDb pool', () => {
  it("has an 'error' listener: an idle-client socket error is logged, not thrown", () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool = (useDb() as unknown as { $client: Pool }).$client
    expect(pool.listenerCount('error')).toBeGreaterThan(0)
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[db] idle pool client error'), 'terminating connection due to administrator command')
    errSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})
