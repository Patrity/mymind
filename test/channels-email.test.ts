// test/channels-email.test.ts
// Cycle 75, Task 5: the email channel (Resend, markdown -> HTML). `sendResendEmail` is stubbed
// via a `$fetch` global (test/stt-whisper.test.ts pattern) — no real Resend call ever happens.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({ loadChannels: vi.fn(), loadObs: vi.fn() }))
vi.mock('../server/lib/channels/config', () => ({ loadChannelsConfig: mocks.loadChannels }))
vi.mock('../server/lib/observability/config', () => ({ loadObsConfig: mocks.loadObs }))

import { renderEmail, emailSubject } from '../server/lib/channels/email/render'
import { emailChannel } from '../server/lib/channels/email/channel'
import { sendResendEmail } from '../server/lib/observability/email'
import { encryptSecret } from '../server/lib/ai/registry/crypto'

// crypto.ts derives its key from BETTER_AUTH_SECRET; set here so this file doesn't depend on
// the shell env (test/ai-registry-crypto.test.ts pattern).
beforeAll(() => { process.env.BETTER_AUTH_SECRET ??= 'test-secret-please-ignore-0123456789' })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('renderEmail', () => {
  it('renders headings, lists and links', () => {
    const { html } = renderEmail('# Title\n\n- one\n- two\n\n[a link](https://example.com)')
    expect(html).toContain('<h1')
    expect(html).toContain('Title')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
    expect(html).toContain('<a href="https://example.com">a link</a>')
  })

  it('escapes a raw <script> tag rather than passing it through', () => {
    const { html } = renderEmail('before\n\n<script>alert(1)</script>\n\nafter')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes a raw <img onerror=…> tag rather than passing it through', () => {
    const { html } = renderEmail('click <img src=x onerror="alert(1)"> here')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('onerror')
  })

  it('text is the original markdown, unmodified', () => {
    const md = '# Title\n\nSome **bold** text with <script>bad()</script>.'
    expect(renderEmail(md).text).toBe(md)
  })

  it('renders an empty message without throwing', () => {
    const { html, text } = renderEmail('')
    expect(text).toBe('')
    expect(html).toContain('<div')
    expect(html).not.toMatch(/undefined|null/)
  })
})

// Fix round 1 (task-5-review.md): marked's html() escaping only intercepts raw-HTML tokens — it
// does nothing for a live href/src marked's own link/image renderers produce from ordinary
// markdown syntax (`[text](url)`, `<url>`, `![alt](url)`). renderEmail now also runs its output
// through isomorphic-dompurify (same package/purpose as shared/utils/sanitize-html.ts and
// app/components/clipboard/MessageText.vue) with a scheme allow-list: links only http/https/
// mailto, image src only http/https — everything else is stripped. Each case below checks the
// *live* attribute is gone (no executable href/src survives) while the surrounding legitimate
// content (the link label, the alt text) survives. The one exception is the bare autolink case:
// CommonMark's `<scheme:...>` autolink has no separate label — its visible text IS the URL
// string — so a sanitizer that preserves content (as DOMPurify and every mainstream one does)
// necessarily leaves that string visible as inert text once the href itself is stripped. What
// must never survive is the *live* href, which the assertion below checks directly.
describe('renderEmail — app-relative links and images (M4)', () => {
  const ORIGIN = 'https://brain.example.test'
  it('an app image embed becomes a working absolute LINK (the image route needs a session)', () => {
    const { html } = renderEmail('Here: ![chart](/api/images/0b0c1d2e-0000-4000-8000-000000000001/raw)', { origin: ORIGIN })
    expect(html).toContain('<a href="https://brain.example.test/api/images/0b0c1d2e-0000-4000-8000-000000000001/raw">chart</a>')
    expect(html).not.toContain('<img')
  })
  it('an app-relative link is made absolute; an alt-less image is labelled "image"', () => {
    const { html } = renderEmail('[your tasks](/tasks) and ![](/api/images/x/raw)', { origin: ORIGIN })
    expect(html).toContain('<a href="https://brain.example.test/tasks">your tasks</a>')
    expect(html).toContain('<a href="https://brain.example.test/api/images/x/raw">image</a>')
  })
  it('external links and images are untouched; protocol-relative (//host) is not treated as app-relative', () => {
    const { html } = renderEmail('[x](https://other.test/a) ![p](https://other.test/p.png) [y](//evil.test/z)', { origin: ORIGIN })
    expect(html).toContain('<a href="https://other.test/a">x</a>')
    expect(html).toContain('<img src="https://other.test/p.png" alt="p">')
    expect(html).not.toContain('evil.test')
  })
})

describe('emailChannel.send — app origin (M4)', () => {
  it('uses BETTER_AUTH_URL\'s origin for app-relative links', async () => {
    mocks.loadChannels.mockResolvedValue({ email: { enabled: true, to: 'tony@example.com' } })
    mocks.loadObs.mockResolvedValue({ alerts: { email: { apiKeyEnc: encryptSecret('resend-key'), from: 'bridget@mymind.dev' } } })
    vi.stubGlobal('useRuntimeConfig', () => ({ betterAuthUrl: 'https://brain.example.test/' }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }))
    vi.stubGlobal('$fetch', fetchMock)
    await emailChannel.send({ id: 'd1', target: 'tony@example.com', payload: { text: '![c](/api/images/abc/raw)' }, attempts: 0, firstClaimedAt: null })
    const [, init] = fetchMock.mock.calls[0] as [string, { body: Record<string, unknown> }]
    expect(init.body.html).toContain('href="https://brain.example.test/api/images/abc/raw"')
  })
})

describe('renderEmail — URL scheme sanitization', () => {
  it('strips a javascript: link href, keeping the link text', () => {
    const { html } = renderEmail('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:alert(1)')
    expect(html).not.toMatch(/<a[^>]*href/i)
    expect(html).toContain('click me')
  })

  it('strips a javascript: autolink href; the inert text (the URL itself) survives', () => {
    const { html } = renderEmail('<javascript:alert(1)>')
    expect(html).not.toMatch(/href\s*=\s*"javascript:/i)
    expect(html).not.toMatch(/<a[^>]*href/i)
    expect(html).toContain('javascript:alert(1)') // inert text, not a live href — see block comment
  })

  it('strips a data: image src, keeping the alt text', () => {
    const { html } = renderEmail('![a broken image](data:image/png;base64,AAAA)')
    expect(html).not.toContain('data:image')
    expect(html).not.toMatch(/<img[^>]*src/i)
    expect(html).toContain('a broken image')
  })

  it('strips a vbscript: link href, keeping the link text', () => {
    const { html } = renderEmail('[click here](vbscript:msgbox(1))')
    expect(html).not.toContain('vbscript:msgbox(1)')
    expect(html).not.toMatch(/<a[^>]*href/i)
    expect(html).toContain('click here')
  })

  it('neutralizes a live onclick attribute from raw inline HTML, keeping the surrounding text', () => {
    const { html } = renderEmail('<a href="https://example.com" onclick="alert(1)">click me</a>')
    // The html()-token escaping (kept from before this fix round) is the layer that neutralizes
    // this vector: the tag is never parsed as a real element, so it never reaches DOMPurify as
    // one — there is no real <a ...> anywhere in the output, live or otherwise. DOMPurify's
    // FORBID_ATTR (onclick/onerror/onload) still runs as defense-in-depth for the same
    // attribute, in case that escaping layer ever regresses. Note: round-tripping the escaped
    // text through DOMPurify's HTML parser/serializer (to apply the URL-scheme sanitization
    // above) normalizes `&quot;` back to a literal `"` in this now-plain-text content — quotes
    // don't need entity-escaping outside an attribute value, so this is not a live attribute
    // re-appearing, just a harmless serialization difference; `<`/`>` (which DO need escaping
    // in text content) stay escaped, which is what actually matters here.
    expect(html).not.toMatch(/<a\b[^>]*\bonclick\s*=/i) // no real <a> element with onclick
    expect(html).not.toMatch(/<a\s/) // no real <a> element at all — the whole tag stayed inert text
    expect(html).toContain('click me')
  })
})

describe('emailSubject', () => {
  it('formats as "Bridget · <label>"', () => {
    expect(emailSubject('morning-brief')).toBe('Bridget · morning-brief')
  })
})

describe('sendResendEmail', () => {
  it('sends html in the request body when given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }))
    vi.stubGlobal('$fetch', fetchMock)
    await sendResendEmail({ apiKey: 'k', from: 'a@b.io', to: 'c@d.io', subject: 's', text: 't', html: '<p>t</p>' })
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: { html?: string } }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.body.html).toBe('<p>t</p>')
  })

  it('omits html when not given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }))
    vi.stubGlobal('$fetch', fetchMock)
    await sendResendEmail({ apiKey: 'k', from: 'a@b.io', to: 'c@d.io', subject: 's', text: 't' })
    const [, init] = fetchMock.mock.calls[0] as [string, { body: { html?: string } }]
    expect('html' in init.body).toBe(false)
  })
})

describe('emailChannel.send', () => {
  const obsCfg = (over: Partial<{ apiKeyEnc: string | null, from: string | null }> = {}) => ({
    alerts: { email: { apiKeyEnc: encryptSecret('resend-key'), from: 'bridget@mymind.dev', ...over } }
  })
  const chCfg = (over: Partial<{ enabled: boolean, to: string | null }> = {}) => ({
    email: { enabled: true, to: 'tony@example.com', ...over }
  })
  const delivery = (over: Partial<{ target: string, payload: { text: string, subject?: string } }> = {}) => ({
    id: 'd1', target: 'tony@example.com', payload: { text: 'hello **world**' }, attempts: 0, firstClaimedAt: null, ...over
  })

  beforeEach(() => {
    mocks.loadChannels.mockReset()
    mocks.loadObs.mockReset()
    mocks.loadChannels.mockResolvedValue(chCfg())
    mocks.loadObs.mockResolvedValue(obsCfg())
  })

  it('posts the target as `to`, and from/key from the observability config', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }))
    vi.stubGlobal('$fetch', fetchMock)

    const r = await emailChannel.send(delivery())

    expect(r.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>, body: Record<string, unknown> }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.authorization).toBe('Bearer resend-key')
    expect(init.body.from).toBe('bridget@mymind.dev')
    expect(init.body.to).toEqual(['tony@example.com'])
    expect(init.body.subject).toBe(emailSubject('message'))
    expect(init.body.html).toContain('<strong>world</strong>')
  })

  it('uses payload.subject when given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }))
    vi.stubGlobal('$fetch', fetchMock)

    await emailChannel.send(delivery({ payload: { text: 'hi', subject: 'custom subject' } }))

    const [, init] = fetchMock.mock.calls[0] as [string, { body: Record<string, unknown> }]
    expect(init.body.subject).toBe('custom subject')
  })

  it('maps a 5xx Resend response to retryable: true', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => { throw Object.assign(new Error('server error'), { response: { status: 500 } }) }))
    const r = await emailChannel.send(delivery())
    expect(r).toMatchObject({ ok: false, retryable: true })
  })

  it('maps a 4xx Resend response to retryable: false', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => { throw Object.assign(new Error('bad request'), { response: { status: 400 } }) }))
    const r = await emailChannel.send(delivery())
    expect(r).toMatchObject({ ok: false, retryable: false })
  })

  it('refuses (non-retryable) with a clear error when the channel is disabled', async () => {
    mocks.loadChannels.mockResolvedValue(chCfg({ enabled: false }))
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    const r = await emailChannel.send(delivery())

    expect(r).toMatchObject({ ok: false, retryable: false })
    expect((r as { error: string }).error).toMatch(/disabled/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses (non-retryable) with a clear error when Resend is unconfigured', async () => {
    mocks.loadObs.mockResolvedValue(obsCfg({ apiKeyEnc: null }))
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    const r = await emailChannel.send(delivery())

    expect(r).toMatchObject({ ok: false, retryable: false })
    expect((r as { error: string }).error).toMatch(/resend/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('emailChannel.isEnabled', () => {
  it('false when the channel is disabled', async () => {
    mocks.loadChannels.mockResolvedValue(chConfigDisabled())
    mocks.loadObs.mockResolvedValue({ alerts: { email: { apiKeyEnc: encryptSecret('k'), from: 'a@b.io' } } })
    expect(await emailChannel.isEnabled()).toBe(false)
  })

  it('false when Resend is unconfigured', async () => {
    mocks.loadChannels.mockResolvedValue({ email: { enabled: true, to: 'tony@example.com' } })
    mocks.loadObs.mockResolvedValue({ alerts: { email: { apiKeyEnc: null, from: null } } })
    expect(await emailChannel.isEnabled()).toBe(false)
  })

  it('true when enabled with a recipient and Resend configured', async () => {
    mocks.loadChannels.mockResolvedValue({ email: { enabled: true, to: 'tony@example.com' } })
    mocks.loadObs.mockResolvedValue({ alerts: { email: { apiKeyEnc: encryptSecret('k'), from: 'a@b.io' } } })
    expect(await emailChannel.isEnabled()).toBe(true)
  })

  function chConfigDisabled() {
    return { email: { enabled: false, to: 'tony@example.com' } }
  }
})
