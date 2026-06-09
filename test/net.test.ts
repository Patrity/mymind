// test/net.test.ts
import { describe, it, expect } from 'vitest'
import { isPrivateAddress } from '../server/utils/net'

describe('isPrivateAddress', () => {
  it('accepts loopback and RFC1918 ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.2.25', '172.16.0.1'])
      expect(isPrivateAddress(ip)).toBe(true)
  })
  it('rejects public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.5'])
      expect(isPrivateAddress(ip)).toBe(false)
  })
  it('handles IPv4-mapped IPv6 and undefined', () => {
    expect(isPrivateAddress('::ffff:192.168.1.5')).toBe(true)
    expect(isPrivateAddress(undefined)).toBe(false)
  })
})
