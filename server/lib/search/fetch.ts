// server/lib/search/fetch.ts
// SSRF-guarded web fetch with HTML→Markdown extraction.

import { lookup } from 'node:dns/promises'
import { NodeHtmlMarkdown } from 'node-html-markdown'

// ---------------------------------------------------------------------------
// isPrivateIp
// ---------------------------------------------------------------------------

/**
 * Returns true if the given IP address string resolves to a private, loopback,
 * link-local, CGNAT, or metadata address that should never be reachable from
 * a server-side fetch.
 *
 * IPv4 ranges blocked:
 *   0.0.0.0/8        – "this" network
 *   10.0.0.0/8       – RFC-1918
 *   100.64.0.0/10    – CGNAT (100.64–127.255.255.255)
 *   127.0.0.0/8      – loopback
 *   169.254.0.0/16   – link-local / AWS metadata
 *   172.16.0.0/12    – RFC-1918 (172.16–172.31)
 *   192.168.0.0/16   – RFC-1918
 *
 * IPv6 ranges blocked:
 *   ::1              – loopback
 *   fc00::/7         – ULA (fc/fd)
 *   fe80::/10        – link-local
 */
export function isPrivateIp(ip: string): boolean {
  // --- IPv6 ---
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe80')) return true
    return false
  }

  // --- IPv4 ---
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (nums.some(n => n === undefined || isNaN(n) || n < 0 || n > 255)) return false
  const a = nums[0] as number
  const b = nums[1] as number

  if (a === 0) return true                                    // 0.0.0.0/8
  if (a === 10) return true                                   // 10.0.0.0/8
  if (a === 127) return true                                  // 127.0.0.0/8
  if (a === 169 && b === 254) return true                     // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true            // 172.16.0.0/12
  if (a === 192 && b === 168) return true                     // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true           // 100.64.0.0/10 CGNAT

  return false
}

// ---------------------------------------------------------------------------
// ssrfCheckUrl
// ---------------------------------------------------------------------------

/**
 * Synchronous pre-flight check against SSRF. Returns { ok: true } for URLs
 * that are safe to fetch, or { ok: false, reason } for blocked URLs.
 *
 * Blocks:
 *  - Non-http(s) schemes
 *  - "localhost" hostname
 *  - Hostnames ending with ".local"
 *  - metadata.google.internal
 *  - IP-literal hosts that isPrivateIp considers private
 */
export function ssrfCheckUrl(raw: string): { ok: boolean; reason?: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Scheme not allowed: ${url.protocol}` }
  }

  const host = url.hostname.toLowerCase()

  if (host === 'localhost') return { ok: false, reason: 'localhost is blocked' }
  if (host.endsWith('.local')) return { ok: false, reason: '.local hosts are blocked' }
  if (host === 'metadata.google.internal') return { ok: false, reason: 'GCE metadata blocked' }

  // IP-literal check (IPv4 or IPv6 in brackets)
  const rawHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (/^[\d.:]+$|^[0-9a-f:]+$/i.test(rawHost)) {
    if (isPrivateIp(rawHost)) {
      return { ok: false, reason: `Private IP blocked: ${rawHost}` }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

/**
 * Strips scripts/styles/nav/chrome elements from HTML, converts to Markdown,
 * and truncates to maxChars (default 8 000) with a continuation marker.
 */
export function htmlToMarkdown(html: string, maxChars = 8000): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '')
  const md = NodeHtmlMarkdown.translate(stripped).trim()
  return md.length > maxChars ? md.slice(0, maxChars) + '\n\n…[truncated]' : md
}

// ---------------------------------------------------------------------------
// fetchAsMarkdown
// ---------------------------------------------------------------------------

export interface FetchedPage {
  url: string
  title: string
  content: string
}

/**
 * Fetches a URL with SSRF guards (static + DNS-rebinding) and returns the
 * page as extracted Markdown.
 *
 * Throws if:
 *  - ssrfCheckUrl rejects the URL
 *  - Any resolved DNS address is private (DNS-rebinding defence)
 *  - The network fetch fails or times out (10 s)
 */
export async function fetchAsMarkdown(url: string): Promise<FetchedPage> {
  const check = ssrfCheckUrl(url)
  if (!check.ok) throw new Error(`SSRF blocked: ${check.reason}`)

  const { hostname } = new URL(url)

  // DNS-rebinding defence: resolve all addresses and reject any private ones
  const records = await lookup(hostname, { all: true })
  for (const { address } of records) {
    if (isPrivateIp(address)) {
      throw new Error(`SSRF blocked: resolved address ${address} is private`)
    }
  }

  const res = await fetch(url, {
    headers: {
      'user-agent': 'MyMind-Bridget/1.0 (+https://github.com/Patrity/mymind)',
    },
    signal: AbortSignal.timeout(10_000),
    redirect: 'follow',
  })

  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`)

  const html = await res.text()

  // Extract title from <title> tag, fall back to hostname
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch?.[1]?.trim() ?? hostname

  const content = htmlToMarkdown(html)
  return { url, title, content }
}
