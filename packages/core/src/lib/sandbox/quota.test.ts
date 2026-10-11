import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTA_BYTES, DEFAULT_QUOTA_INODES, MEASURE_COMMAND, SandboxDiskLowError, SandboxQuotaError, assertWithinQuota, formatBytes, parseDu } from './quota'

const Q = { bytes: DEFAULT_QUOTA_BYTES, inodes: DEFAULT_QUOTA_INODES }

describe('quota', () => {
  it('is 5 GB and 200k files', () => {
    expect(DEFAULT_QUOTA_BYTES).toBe(5 * 1024 ** 3)
    expect(DEFAULT_QUOTA_INODES).toBe(200_000)
  })
  it('measures with an in-container timeout (review M9)', () => {
    expect(MEASURE_COMMAND.match(/timeout -k 5 100 du/g)).toHaveLength(2)
    expect(MEASURE_COMMAND).toContain('--inodes')
  })
  it('parses du output (bytes, then files)', () => {
    expect(parseDu('12345\n17\n')).toEqual({ bytes: 12345, inodes: 17 })
    expect(parseDu('12345\n')).toBeNull()
    expect(parseDu('du: cannot access')).toBeNull()
  })
  it('refuses over quota with a clear message', () => {
    expect(() => assertWithinQuota({ bytes: 10, inodes: 10 }, { bytes: 10, inodes: 10 })).not.toThrow()
    const e = (() => { try { assertWithinQuota({ bytes: 6 * 1024 ** 3, inodes: 5 }, Q) } catch (x) { return x } })() as SandboxQuotaError
    expect(e).toBeInstanceOf(SandboxQuotaError)
    expect(e.message).toBe('workspace is over its 5.0 GB quota (6.0 GB used) — writes are refused and background shells were stopped; delete files to free space')
  })
  it('refuses over the file quota with its own message', () => {
    const e = (() => { try { assertWithinQuota({ bytes: 10, inodes: 250_000 }, Q) } catch (x) { return x } })() as SandboxQuotaError
    expect(e.message).toBe('workspace is over its 200,000-file quota (250,000 files) — writes are refused and background shells were stopped; delete files to free space')
  })
  it('low disk message', () => {
    expect(new SandboxDiskLowError(3 * 1024 ** 3, 4 * 1024 ** 3).message).toContain('3.0 GB free, needs 4.0 GB')
  })
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024 ** 2)).toBe('20 MB')
  })
})

describe('sandboxRequireFirewall (review M1)', async () => {
  const { sandboxRequireFirewall } = await import('../../config-env')
  it('defaults to the platform, never to NODE_ENV', () => {
    expect(sandboxRequireFirewall({}, 'linux')).toBe(true)
    expect(sandboxRequireFirewall({ NODE_ENV: 'development' }, 'linux')).toBe(true)
    expect(sandboxRequireFirewall({}, 'darwin')).toBe(false)
    expect(sandboxRequireFirewall({ NODE_ENV: 'production' }, 'darwin')).toBe(false)
  })
  it('honours an explicit value', () => {
    expect(sandboxRequireFirewall({ SANDBOX_REQUIRE_FIREWALL: 'false' }, 'linux')).toBe(false)
    expect(sandboxRequireFirewall({ SANDBOX_REQUIRE_FIREWALL: '1' }, 'darwin')).toBe(true)
    expect(sandboxRequireFirewall({ SANDBOX_REQUIRE_FIREWALL: 'maybe' }, 'linux')).toBe(true)
  })
})
