import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTA_BYTES, SandboxQuotaError, assertWithinQuota, formatBytes, parseDu } from './quota'

describe('quota', () => {
  it('is 5 GB', () => expect(DEFAULT_QUOTA_BYTES).toBe(5 * 1024 ** 3))
  it('parses du output', () => {
    expect(parseDu('12345\n')).toBe(12345)
    expect(parseDu('du: cannot access')).toBeNull()
  })
  it('refuses over quota with a clear message', () => {
    expect(() => assertWithinQuota(10, 10)).not.toThrow()
    const e = (() => { try { assertWithinQuota(6 * 1024 ** 3, DEFAULT_QUOTA_BYTES) } catch (x) { return x } })() as SandboxQuotaError
    expect(e).toBeInstanceOf(SandboxQuotaError)
    expect(e.message).toBe('workspace is over its 5.0 GB quota (6.0 GB used) — writes are refused and background shells were stopped; delete files to free space')
  })
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024 ** 2)).toBe('20 MB')
  })
})
