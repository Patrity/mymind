// test/mcp-host-guard.test.ts
// DNS-rebinding guards. These call the guard functions DIRECTLY rather than over HTTP on purpose:
// Node's fetch treats `Host` as a forbidden header and silently strips it, so a round-trip
// "bad host" test never reaches the guard and reports an unrelated status (406 from content
// negotiation) that looks deceptively like a pass.
import { describe, it, expect } from 'vitest'
import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { mcpAllowedHosts, mcpAllowedOrigins } from '../server/lib/mcp/guards'

const req = (headers: Record<string, string>) =>
  new Request('http://brain.costanzoclan.com/api/mcp', { method: 'POST', headers })

describe('MCP DNS-rebinding guards', () => {
  const allowed = mcpAllowedHosts('https://brain.costanzoclan.com')

  it('falls back to localhost-only when no URL is configured', () => {
    // Fail closed: an unset config must not silently allow every Host.
    expect(mcpAllowedHosts(undefined)).toEqual(['localhost', '127.0.0.1', '[::1]'])
  })

  it('allows the production host', () => {
    expect(hostHeaderValidationResponse(req({ host: 'brain.costanzoclan.com' }), allowed)).toBeUndefined()
  })

  it('allows localhost for dev', () => {
    expect(hostHeaderValidationResponse(req({ host: 'localhost:3000' }), allowed)).toBeUndefined()
  })

  it('allows IPv6 loopback ([::1]) for dev', () => {
    expect(hostHeaderValidationResponse(req({ host: '[::1]:3000' }), allowed)).toBeUndefined()
  })

  it('rejects an unknown Host with 403', () => {
    expect(hostHeaderValidationResponse(req({ host: 'evil.example.com' }), allowed)?.status).toBe(403)
  })

  it('rejects a cross-site Origin with 403', () => {
    const r = req({ host: 'brain.costanzoclan.com', origin: 'https://evil.example.com' })
    expect(originValidationResponse(r, allowed)?.status).toBe(403)
  })

  it('allows a request with no Origin — machine clients never send one', () => {
    expect(originValidationResponse(req({ host: 'brain.costanzoclan.com' }), allowed)).toBeUndefined()
  })
})

describe('MCP Origin/Host allowlist split (claude.ai connector)', () => {
  const allowedOrigins = mcpAllowedOrigins('https://brain.costanzoclan.com')

  it('originValidationResponse ACCEPTS Origin: https://claude.ai', () => {
    const r = req({ host: 'brain.costanzoclan.com', origin: 'https://claude.ai' })
    expect(originValidationResponse(r, allowedOrigins)).toBeUndefined()
  })

  it('originValidationResponse ACCEPTS another Anthropic origin (claude.com)', () => {
    const r = req({ host: 'brain.costanzoclan.com', origin: 'https://claude.com' })
    expect(originValidationResponse(r, allowedOrigins)).toBeUndefined()
  })

  it('hostHeaderValidationResponse still REJECTS Host: claude.ai with 403 — the Host surface was NOT widened', () => {
    const allowedHosts = mcpAllowedHosts('https://brain.costanzoclan.com')
    expect(hostHeaderValidationResponse(req({ host: 'claude.ai' }), allowedHosts)?.status).toBe(403)
  })

  it('originValidationResponse still rejects an unrelated cross-site origin with 403', () => {
    const r = req({ host: 'brain.costanzoclan.com', origin: 'https://evil.example.com' })
    expect(originValidationResponse(r, allowedOrigins)?.status).toBe(403)
  })

  it('originValidationResponse still allows a request with no Origin', () => {
    expect(originValidationResponse(req({ host: 'brain.costanzoclan.com' }), allowedOrigins)).toBeUndefined()
  })
})
