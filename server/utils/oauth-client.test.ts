import { describe, it, expect } from 'vitest'
import { clientDisplayName, redirectHosts, MAX_CLIENT_NAME_LEN } from './oauth-client'

const CLIENT_ID = 'bzbsWAOumxSrcrmwnbWvBeMQjmzIxAUL'

describe('clientDisplayName', () => {
  it('uses the registered name when present', () => {
    expect(clientDisplayName('Claude', CLIENT_ID)).toBe('Claude')
  })

  it('falls back to the client id when the name is missing', () => {
    expect(clientDisplayName(null, CLIENT_ID)).toBe(CLIENT_ID)
    expect(clientDisplayName(undefined, CLIENT_ID)).toBe(CLIENT_ID)
    expect(clientDisplayName('', CLIENT_ID)).toBe(CLIENT_ID)
  })

  it('falls back when the name is only whitespace', () => {
    expect(clientDisplayName('   \t \n ', CLIENT_ID)).toBe(CLIENT_ID)
  })

  it('collapses internal whitespace so a newline cannot push the warning out of view', () => {
    expect(clientDisplayName('Claude\n\n\n\nOfficial', CLIENT_ID)).toBe('Claude Official')
  })

  it('truncates an over-long name', () => {
    const long = 'A'.repeat(MAX_CLIENT_NAME_LEN + 40)
    const result = clientDisplayName(long, CLIENT_ID)
    expect(result).toBe(`${'A'.repeat(MAX_CLIENT_NAME_LEN)}…`)
    expect(result.length).toBe(MAX_CLIENT_NAME_LEN + 1)
  })

  it('leaves a name exactly at the limit untouched', () => {
    const exact = 'B'.repeat(MAX_CLIENT_NAME_LEN)
    expect(clientDisplayName(exact, CLIENT_ID)).toBe(exact)
  })
})

describe('redirectHosts', () => {
  it('extracts the host from a single redirect uri', () => {
    expect(redirectHosts('https://claude.ai/api/mcp/auth_callback')).toEqual(['claude.ai'])
  })

  it('handles a comma-separated list', () => {
    expect(redirectHosts('https://claude.ai/cb,https://desktop.claude.ai/cb'))
      .toEqual(['claude.ai', 'desktop.claude.ai'])
  })

  it('de-duplicates several callback paths on one domain', () => {
    expect(redirectHosts('https://claude.ai/a,https://claude.ai/b')).toEqual(['claude.ai'])
  })

  it('preserves a non-default port, which is part of the origin', () => {
    expect(redirectHosts('http://127.0.0.1:19191/cb')).toEqual(['127.0.0.1:19191'])
  })

  it('drops unparseable entries instead of rendering them raw', () => {
    expect(redirectHosts('not-a-url,https://claude.ai/cb')).toEqual(['claude.ai'])
  })

  it('returns an empty list for missing or blank input', () => {
    expect(redirectHosts(null)).toEqual([])
    expect(redirectHosts(undefined)).toEqual([])
    expect(redirectHosts('')).toEqual([])
    expect(redirectHosts('  ,  ')).toEqual([])
  })
})
