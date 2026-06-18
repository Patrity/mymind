import { describe, it, expect } from 'vitest'
import { isPrivateIp, ssrfCheckUrl, htmlToMarkdown } from '../server/lib/search/fetch'

describe('isPrivateIp', () => {
  it('flags private/loopback/link-local/ULA/CGNAT/metadata', () => {
    for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fc00::1'])
      expect(isPrivateIp(ip)).toBe(true)
  })
  it('allows public IPs', () => {
    for (const ip of ['8.8.8.8','1.1.1.1','93.184.216.34']) expect(isPrivateIp(ip)).toBe(false)
  })
  it('flags IPv6 ULA and link-local', () => {
    expect(isPrivateIp('fd00::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true)
  })
  it('flags IPv4-mapped IPv6 (dotted-quad form)', () => {
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true)
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true)
  })
  it('allows IPv4-mapped IPv6 for public IPs', () => {
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false)
  })
})
describe('ssrfCheckUrl', () => {
  it('blocks non-http schemes + internal hosts', () => {
    expect(ssrfCheckUrl('ftp://x.com').ok).toBe(false)
    expect(ssrfCheckUrl('http://localhost/x').ok).toBe(false)
    expect(ssrfCheckUrl('http://169.254.169.254/').ok).toBe(false)
    expect(ssrfCheckUrl('http://foo.local/').ok).toBe(false)
    expect(ssrfCheckUrl('http://192.168.1.10/').ok).toBe(false)
  })
  it('allows public https URLs', () => { expect(ssrfCheckUrl('https://example.com/p').ok).toBe(true) })
  it('blocks trailing-dot localhost', () => {
    expect(ssrfCheckUrl('http://localhost./').ok).toBe(false)
  })
  it('blocks IPv4-mapped IPv6 private address', () => {
    expect(ssrfCheckUrl('http://[::ffff:192.168.1.1]/').ok).toBe(false)
  })
})
describe('htmlToMarkdown', () => {
  it('strips scripts/styles and converts, truncating at maxChars', () => {
    const md = htmlToMarkdown('<h1>Hi</h1><script>evil()</script><style>x{}</style><p>Body text</p>')
    expect(md).toMatch(/Hi/); expect(md).toMatch(/Body text/); expect(md).not.toMatch(/evil/)
    expect(htmlToMarkdown('<p>' + 'x'.repeat(200) + '</p>', 50).length).toBeLessThanOrEqual(70)
  })
})
