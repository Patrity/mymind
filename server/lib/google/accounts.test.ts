import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./connections', async (importOriginal) => {
  const real = await importOriginal<typeof import('./connections')>()
  return {
    ...real,
    listConnections: vi.fn()
  }
})

import { resolveAccounts, fanOut } from './accounts'
import { listConnections, type Connection } from './connections'
import { GoogleReconnectError } from './token'

function conn(overrides: Partial<Connection>): Connection {
  return {
    id: 'conn-1',
    accountId: 'acc-1',
    userId: 'user-1',
    googleSub: 'sub-1',
    provider: 'google',
    label: 'work',
    email: 'tony@work.com',
    status: 'ok',
    lastError: null,
    ...overrides
  }
}

const work = conn({ id: 'conn-work', label: 'work', email: 'tony@work.com' })
const personal = conn({ id: 'conn-personal', label: 'personal', email: 'tony@costanzoclan.com' })

beforeEach(() => {
  vi.mocked(listConnections).mockReset()
})

describe('resolveAccounts', () => {
  it('no connections → ok:false with the connect-one message', async () => {
    vi.mocked(listConnections).mockResolvedValue([])
    const result = await resolveAccounts(undefined, { write: false })
    expect(result).toEqual({ ok: false, error: 'no Google account connected — connect one in Settings → Connections' })
  })

  it('write:true without account → error listing labels', async () => {
    vi.mocked(listConnections).mockResolvedValue([work, personal])
    const result = await resolveAccounts(undefined, { write: true })
    expect(result).toEqual({ ok: false, error: 'name an account: work, personal' })
  })

  it('unknown label → error listing labels', async () => {
    vi.mocked(listConnections).mockResolvedValue([work, personal])
    const result = await resolveAccounts('nope', { write: false })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('work, personal')
      expect(result.error).toContain('nope')
    }
  })

  it('matches by email', async () => {
    vi.mocked(listConnections).mockResolvedValue([work, personal])
    const result = await resolveAccounts('tony@costanzoclan.com', { write: true })
    expect(result).toEqual({ ok: true, connections: [personal] })
  })

  it('matches by label case-insensitively', async () => {
    vi.mocked(listConnections).mockResolvedValue([work, personal])
    const result = await resolveAccounts('WORK', { write: true })
    expect(result).toEqual({ ok: true, connections: [work] })
  })

  it('read without account → returns every connection, ok and needs_reconnect alike', async () => {
    const broken = conn({ id: 'conn-broken', label: 'broken', status: 'needs_reconnect' })
    vi.mocked(listConnections).mockResolvedValue([work, broken])
    const result = await resolveAccounts(undefined, { write: false })
    expect(result).toEqual({ ok: true, connections: [work, broken] })
  })
})

describe('fanOut', () => {
  it('skips a needs_reconnect connection with a warning, without calling it', async () => {
    const broken = conn({ id: 'conn-broken', label: 'broken', status: 'needs_reconnect' })
    const fn = vi.fn(async (c: Connection) => [{ id: `${c.label}-1` }])
    const { items, warnings } = await fanOut([work, broken], fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(work)
    expect(items).toEqual([{ id: 'work-1', account: 'work' }])
    expect(warnings).toEqual(['broken: needs reconnecting in Settings → Connections'])
  })

  it('one connection throwing GoogleReconnectError mid-call is downgraded to a warning, others still return', async () => {
    const fn = vi.fn(async (c: Connection) => {
      if (c.label === 'work') throw new GoogleReconnectError(c, 'revoked')
      return [{ id: `${c.label}-1` }]
    })
    const { items, warnings } = await fanOut([work, personal], fn)
    expect(items).toEqual([{ id: 'personal-1', account: 'personal' }])
    expect(warnings).toEqual(['work: needs reconnecting in Settings → Connections'])
  })

  it('tags every item with its account label', async () => {
    const fn = vi.fn(async (c: Connection) => [{ id: 'a' }, { id: 'b' }])
    const { items } = await fanOut([work], fn)
    expect(items).toEqual([{ id: 'a', account: 'work' }, { id: 'b', account: 'work' }])
  })

  it('a non-reconnect error from one connection is reported as a warning, not thrown', async () => {
    const fn = vi.fn(async (c: Connection) => {
      if (c.label === 'work') throw new Error('boom')
      return [{ id: `${c.label}-1` }]
    })
    const { items, warnings } = await fanOut([work, personal], fn)
    expect(items).toEqual([{ id: 'personal-1', account: 'personal' }])
    expect(warnings).toEqual(['work: boom'])
  })
})
