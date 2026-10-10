// server/lib/google/mime.ts
// Builds the base64url RFC 2822 `raw` message Gmail's send/draft APIs want, and parses a Gmail
// message payload tree back down to plain text + a list of attachment filenames.

import { htmlToMarkdown } from '../search/fetch'

export type GmailPayload = {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size?: number }
  parts?: GmailPayload[]
}

const TRUNCATION_MARKER = '… [truncated]'
// Large enough that htmlToMarkdown's own (unrelated) 8000-char default never kicks in here —
// truncation to the caller's maxChars happens once, below, after HTML has become text.
const NO_INNER_TRUNCATION = 10_000_000

function isAscii(s: string): boolean {
  return /^[\x00-\x7F]*$/.test(s)
}

function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

const CRLF = /[\r\n]/

/** Every header value is tool-written and so reachable from prompt-injected email content — a
 *  bare CR or LF would let `"hi\r\nBcc: attacker@x.com"` inject a new header line into the raw
 *  RFC 2822 message. Reject outright (the Gmail tool wrapping this turns the throw into
 *  `{ error }`) rather than strip, since stripping could silently produce a different-looking
 *  message than the model intended. */
function assertNoHeaderInjection(label: string, value: string): void {
  if (CRLF.test(value)) {
    throw new Error(`invalid ${label}: contains a line break`)
  }
}

export function buildRawMessage(m: {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}): string {
  assertNoHeaderInjection('from', m.from)
  for (const addr of m.to) assertNoHeaderInjection('to', addr)
  for (const addr of m.cc ?? []) assertNoHeaderInjection('cc', addr)
  assertNoHeaderInjection('subject', m.subject)
  if (m.inReplyTo) assertNoHeaderInjection('in-reply-to', m.inReplyTo)
  if (m.references) assertNoHeaderInjection('references', m.references)

  const lines: string[] = [
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`
  ]
  if (m.cc && m.cc.length > 0) lines.push(`Cc: ${m.cc.join(', ')}`)
  lines.push(`Subject: ${encodeHeaderValue(m.subject)}`)
  if (m.inReplyTo) lines.push(`In-Reply-To: ${m.inReplyTo}`)
  if (m.references) lines.push(`References: ${m.references}`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  lines.push('Content-Transfer-Encoding: 8bit')
  lines.push('')
  // The body is free text, not a header — newlines are expected. Normalize whatever line
  // endings it arrived with to CRLF so the message is CRLF-consistent end to end.
  lines.push(m.body.replace(/\r\n|\r|\n/g, '\r\n'))

  const message = lines.join('\r\n')
  return Buffer.from(message, 'utf8').toString('base64url')
}

export function header(p: GmailPayload, name: string): string | undefined {
  const needle = name.toLowerCase()
  return p.headers?.find(h => h.name.toLowerCase() === needle)?.value
}

function decodePart(data: string | undefined): string {
  if (!data) return ''
  return Buffer.from(data, 'base64url').toString('utf8')
}

interface Collected {
  plain?: string
  html?: string
  attachments: string[]
}

function walk(p: GmailPayload, out: Collected): void {
  // A part with a filename is an attachment, regardless of its mimeType — don't also pull
  // text out of it (attachment bodies are usually fetched separately by attachmentId anyway).
  if (p.filename) {
    out.attachments.push(p.filename)
    return
  }

  if (p.parts && p.parts.length > 0) {
    for (const part of p.parts) walk(part, out)
    return
  }

  const mime = p.mimeType ?? ''
  if (mime === 'text/plain' && out.plain === undefined) {
    out.plain = decodePart(p.body?.data)
  } else if (mime === 'text/html' && out.html === undefined) {
    out.html = decodePart(p.body?.data)
  }
}

/** multipart/alternative prefers text/plain over text/html; a nested multipart/mixed with an
 *  attachment still finds the text part and lists the attachment filename separately. */
export function parseMessagePayload(payload: GmailPayload, maxChars: number): { text: string; attachments: string[] } {
  const collected: Collected = { attachments: [] }
  walk(payload, collected)

  const raw = collected.plain !== undefined
    ? collected.plain
    : collected.html !== undefined
      ? htmlToMarkdown(collected.html, NO_INNER_TRUNCATION)
      : ''

  const text = raw.length > maxChars ? raw.slice(0, maxChars) + TRUNCATION_MARKER : raw
  return { text, attachments: collected.attachments }
}

/** RFC 2047 encoded-words (`=?UTF-8?B?…?=` / `?Q?`) → text. Adjacent words separated only by
 *  whitespace are joined, per the RFC. Charsets other than UTF-8 are decoded as UTF-8 best effort. */
function decodeEncodedWords(v: string): string {
  return v
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole: string, _cs: string, enc: string, txt: string) => {
      try {
        if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString('utf8')
        const bytes = txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)))
        return Buffer.from(bytes, 'latin1').toString('utf8')
      } catch {
        return whole
      }
    })
}

/** The header block of a base64url `raw` RFC 2822 message (e.g. a draft fetched with
 *  format=raw) as a GmailPayload — unfolded and encoded-word-decoded — so `header()` works on it. */
export function rawMessageHeaders(raw: string): GmailPayload {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  const end = text.search(/\r?\n\r?\n/)
  const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  const headers = block.split(/\r?\n/).flatMap((line) => {
    const i = line.indexOf(':')
    if (i <= 0) return []
    return [{ name: line.slice(0, i).trim(), value: decodeEncodedWords(line.slice(i + 1).trim()) }]
  })
  return { headers }
}
