// GET /api/health (cycle 86): DB-touching, and reports the running release's sha for CD's web gate.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
const execute = vi.fn(async () => [])
vi.mock('@mymind/core/db', () => ({ useDb: () => ({ execute }) }))

const handler = (await import('../server/api/health.get')).default as () => Promise<unknown>

afterEach(() => { vi.unstubAllEnvs(); execute.mockClear() })

describe('GET /api/health', () => {
  it('runs a DB query and returns the release sha from MYMIND_GIT_SHA', async () => {
    vi.stubEnv('MYMIND_GIT_SHA', 'abc123')
    expect(await handler()).toEqual({ ok: true, sha: 'abc123' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('reports sha null when no release sha is set', async () => {
    vi.stubEnv('MYMIND_GIT_SHA', '')
    expect(await handler()).toEqual({ ok: true, sha: null })
  })

  it('fails when the DB does', async () => {
    execute.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(handler()).rejects.toThrow('ECONNREFUSED')
  })
})
