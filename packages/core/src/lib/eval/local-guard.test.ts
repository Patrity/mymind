import { describe, it, expect } from 'vitest'
import { databaseHost, localRunRefusal } from './local-guard'

const ok = { env: { NODE_ENV: 'development' }, databaseUrl: 'postgres://u:p@localhost:5433/mymind', iKnow: true, workerOnline: false }

describe('localRunRefusal (fix round 1, I3)', () => {
  it('allows a dev run against a local DB with --i-know and no worker online', () => {
    expect(localRunRefusal(ok)).toBeNull()
    expect(localRunRefusal({ ...ok, databaseUrl: 'postgres://u@127.0.0.1/x' })).toBeNull()
    expect(localRunRefusal({ ...ok, databaseUrl: 'postgres://u@/x?host=/var/run/postgresql' })).toBeNull()
  })

  it('refuses production, the exclusive worker env, a remote DB, a live worker, and no --i-know', () => {
    expect(localRunRefusal({ ...ok, env: { NODE_ENV: 'production' } })).toEqual(expect.stringMatching(/production/))
    expect(localRunRefusal({ ...ok, env: { AGENT_RUNTIME_EXCLUSIVE: '1' } })).toEqual(expect.stringMatching(/AGENT_RUNTIME_EXCLUSIVE/))
    expect(localRunRefusal({ ...ok, databaseUrl: 'postgres://u:p@192.168.2.50:5432/mymind' })).toEqual(expect.stringMatching(/non-local database \(192\.168\.2\.50\)/))
    expect(localRunRefusal({ ...ok, databaseUrl: 'postgres://u:p@localhost.evil.net/x' })).toEqual(expect.stringMatching(/non-local/))
    expect(localRunRefusal({ ...ok, workerOnline: true })).toEqual(expect.stringMatching(/worker is online/))
    expect(localRunRefusal({ ...ok, iKnow: false })).toEqual(expect.stringMatching(/--i-know/))
    expect(localRunRefusal({ ...ok, databaseUrl: undefined })).toEqual(expect.stringMatching(/DATABASE_URL/))
  })

  it('MYMIND_EVAL_LOCAL_HOSTS allows a named dev host', () => {
    const remote = { ...ok, databaseUrl: 'postgres://u@devbox.lan/x' }
    expect(localRunRefusal(remote)).toEqual(expect.stringMatching(/non-local/))
    expect(localRunRefusal({ ...remote, env: { MYMIND_EVAL_LOCAL_HOSTS: 'other, devbox.lan' } })).toBeNull()
  })

  it('databaseHost', () => {
    expect(databaseHost('postgres://u@LocalHost:1/x')).toBe('localhost')
    expect(databaseHost('postgres://u@/x?host=/tmp')).toBe('')
    expect(databaseHost('nope')).toBeNull()
  })
})
