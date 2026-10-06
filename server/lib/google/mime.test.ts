import { describe, it, expect } from 'vitest'
import { buildRawMessage, parseMessagePayload, header, type GmailPayload } from './mime'

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

describe('buildRawMessage', () => {
  it('builds a base64url RFC 2822 message with CRLF endings', () => {
    const raw = buildRawMessage({
      from: 'me@costanzoclan.com',
      to: ['a@x.com', 'b@y.com'],
      subject: 'Hello',
      body: 'Hi there'
    })

    // base64url never contains + / =
    expect(raw).not.toMatch(/[+/=]/)

    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('To: a@x.com, b@y.com')
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(decoded).toContain('\r\n')
    expect(decoded.split('\r\n\r\n')[1]).toBe('Hi there')
  })

  it('RFC 2047 encodes a non-ASCII subject', () => {
    const raw = buildRawMessage({
      from: 'me@costanzoclan.com',
      to: ['a@x.com'],
      subject: 'Café ☕',
      body: 'body'
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const expected = `=?UTF-8?B?${Buffer.from('Café ☕', 'utf8').toString('base64')}?=`
    expect(decoded).toContain(`Subject: ${expected}`)
  })

  it('includes In-Reply-To and References when given', () => {
    const raw = buildRawMessage({
      from: 'me@costanzoclan.com',
      to: ['a@x.com'],
      subject: 'Re: thread',
      body: 'body',
      inReplyTo: '<msg-1@mail.gmail.com>',
      references: '<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>'
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('In-Reply-To: <msg-1@mail.gmail.com>')
    expect(decoded).toContain('References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>')
  })

  it('omits In-Reply-To/References and Cc when not given', () => {
    const raw = buildRawMessage({
      from: 'me@costanzoclan.com',
      to: ['a@x.com'],
      subject: 'Hello',
      body: 'body'
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).not.toContain('In-Reply-To')
    expect(decoded).not.toContain('References')
    expect(decoded).not.toContain('Cc:')
  })

  it('joins Cc addresses when given', () => {
    const raw = buildRawMessage({
      from: 'me@costanzoclan.com',
      to: ['a@x.com'],
      cc: ['c@z.com', 'd@w.com'],
      subject: 'Hello',
      body: 'body'
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('Cc: c@z.com, d@w.com')
  })
})

describe('header', () => {
  it('finds a header by case-insensitive name', () => {
    const p: GmailPayload = { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@x.com' }] }
    expect(header(p, 'subject')).toBe('Hi')
    expect(header(p, 'FROM')).toBe('a@x.com')
    expect(header(p, 'To')).toBeUndefined()
  })
})

describe('parseMessagePayload', () => {
  it('multipart/alternative prefers text/plain over text/html', () => {
    const payload: GmailPayload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('plain body') } },
        { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } }
      ]
    }
    const { text, attachments } = parseMessagePayload(payload, 1000)
    expect(text).toBe('plain body')
    expect(attachments).toEqual([])
  })

  it('HTML-only message is converted via htmlToMarkdown', () => {
    const payload: GmailPayload = {
      mimeType: 'text/html',
      body: { data: b64url('<p>Hello <strong>world</strong></p>') }
    }
    const { text } = parseMessagePayload(payload, 1000)
    expect(text).toContain('Hello')
    expect(text).toContain('world')
  })

  it('nested multipart/mixed with an attachment lists the filename and extracts the text part', () => {
    const payload: GmailPayload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('see attached') } },
            { mimeType: 'text/html', body: { data: b64url('<p>see attached</p>') } }
          ]
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { size: 12345 }
        }
      ]
    }
    const { text, attachments } = parseMessagePayload(payload, 1000)
    expect(text).toBe('see attached')
    expect(attachments).toEqual(['invoice.pdf'])
  })

  it('truncates to maxChars with a trailing marker', () => {
    const payload: GmailPayload = {
      mimeType: 'text/plain',
      body: { data: b64url('x'.repeat(50)) }
    }
    const { text } = parseMessagePayload(payload, 10)
    expect(text).toBe('x'.repeat(10) + '… [truncated]')
  })

  it('returns empty text and no attachments for an empty payload', () => {
    const { text, attachments } = parseMessagePayload({}, 1000)
    expect(text).toBe('')
    expect(attachments).toEqual([])
  })
})
