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
