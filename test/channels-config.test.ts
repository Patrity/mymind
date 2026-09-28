// Cycle 75, Task 3: pure parse / redact / merge for the channel settings (no DB).
import { describe, it, expect, beforeAll } from 'vitest'
import {
  parseChannelsConfig, redactChannelsConfig, mergeChannelsPut, blueBubblesPassword,
  newWebhookToken, ChannelsConfigError, type ChannelsConfig, type ChannelsPutBody
} from '../server/lib/channels/config'
import { encryptSecret, decryptSecret } from '../server/lib/ai/registry/crypto'

beforeAll(() => { process.env.BETTER_AUTH_SECRET ||= 'test-secret-test-secret-test-secret' })

function base(over: Partial<ChannelsConfig['imessage']> = {}): ChannelsConfig {
  return {
    imessage: {
      enabled: true, serverUrl: 'http://bb.local:1234', passwordEnc: encryptSecret('hunter2'),
      webhookToken: 'a'.repeat(64), allowedHandles: ['+15551234567', 'tony@example.com'],
      defaultHandle: '+15551234567', defaultChatGuid: 'iMessage;-;+15551234567', ...over
    },
    email: { enabled: false, to: null },
    presenceAwayMinutes: 10
  }
}

function body(over: Partial<ChannelsPutBody['imessage']> = {}, rest: Partial<ChannelsPutBody> = {}): ChannelsPutBody {
  return {
    imessage: {
      enabled: true, serverUrl: 'http://bb.local:1234', password: { keep: true },
      allowedHandles: ['+15551234567', 'tony@example.com'], defaultHandle: '+15551234567', ...over
    },
    email: { enabled: false, to: null },
    presenceAwayMinutes: 10,
    ...rest
  }
}

describe('parseChannelsConfig', () => {
  it('defaults: disabled, no handles, presence 10, fresh token', () => {
    const c = parseChannelsConfig({})
    expect(c.imessage.enabled).toBe(false)
    expect(c.imessage.serverUrl).toBe('')
    expect(c.imessage.passwordEnc).toBeNull()
    expect(c.imessage.allowedHandles).toEqual([])
    expect(c.imessage.defaultHandle).toBeNull()
    expect(c.imessage.defaultChatGuid).toBeNull()
    expect(c.email).toEqual({ enabled: false, to: null })
    expect(c.presenceAwayMinutes).toBe(10)
    expect(c.imessage.webhookToken).toMatch(/^[0-9a-f]{64}$/)
  })
  it('keeps a stored token', () => {
    const c = parseChannelsConfig({ imessage: { webhookToken: 'b'.repeat(64) } })
    expect(c.imessage.webhookToken).toBe('b'.repeat(64))
  })
  it('two parses without a token generate different tokens', () => {
    expect(parseChannelsConfig({}).imessage.webhookToken).not.toBe(parseChannelsConfig({}).imessage.webhookToken)
  })
})

describe('newWebhookToken', () => {
  it('is 32 random bytes as hex', () => {
    expect(newWebhookToken()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('redactChannelsConfig', () => {
  it('never carries passwordEnc or a webhookToken field; the token only inside webhookUrlPath', () => {
    const c = base()
    const dto = redactChannelsConfig(c, true)
    const json = JSON.stringify(dto)
    expect(json).not.toContain(c.imessage.passwordEnc!)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('passwordEnc')
    expect(json).not.toContain('"webhookToken"')
    expect(dto.imessage.hasPassword).toBe(true)
    expect(dto.imessage.webhookUrlPath).toBe(`/api/channels/bluebubbles/webhook?token=${'a'.repeat(64)}`)
    // The one sanctioned appearance of the token (controller amendment): inside webhookUrlPath only.
    expect(json.split('a'.repeat(64)).length - 1).toBe(1)
    expect(dto.email.resendReady).toBe(true)
  })
  it('hasPassword false when none stored', () => {
    expect(redactChannelsConfig(base({ passwordEnc: null }), false).imessage.hasPassword).toBe(false)
  })
})

describe('blueBubblesPassword', () => {
  it('decrypts the stored password, null when none', () => {
    expect(blueBubblesPassword(base().imessage)).toBe('hunter2')
    expect(blueBubblesPassword(base({ passwordEnc: null }).imessage)).toBeNull()
  })
})

describe('mergeChannelsPut', () => {
  it('{ password } replaces the encrypted value', () => {
    const existing = base()
    const m = mergeChannelsPut(existing, body({ password: { password: 'new-pass' } }))
    expect(m.imessage.passwordEnc).not.toBe(existing.imessage.passwordEnc)
    expect(decryptSecret(m.imessage.passwordEnc!)).toBe('new-pass')
  })
  it('{ keep: true } keeps it', () => {
    const existing = base()
    expect(mergeChannelsPut(existing, body({ password: { keep: true } })).imessage.passwordEnc).toBe(existing.imessage.passwordEnc)
  })
  it('null clears it', () => {
    expect(mergeChannelsPut(base(), body({ password: null })).imessage.passwordEnc).toBeNull()
  })
  it('normalises, de-duplicates and drops empty handles', () => {
    const m = mergeChannelsPut(base(), body({
      allowedHandles: ['(555) 123-4567', '+1 555 123 4567', '  ', 'Tony@Example.com', 'mailto:tony@example.com', ''],
      defaultHandle: '555-123-4567'
    }))
    expect(m.imessage.allowedHandles).toEqual(['+15551234567', 'tony@example.com'])
    expect(m.imessage.defaultHandle).toBe('+15551234567')
  })
  it('rejects a defaultHandle that is not an allowed handle', () => {
    expect(() => mergeChannelsPut(base(), body({ defaultHandle: '+15559999999' }))).toThrow(ChannelsConfigError)
    try { mergeChannelsPut(base(), body({ defaultHandle: '+15559999999' })) }
    catch (e) { expect((e as ChannelsConfigError).statusCode).toBe(400) }
  })
  it('accepts a null defaultHandle', () => {
    expect(mergeChannelsPut(base(), body({ defaultHandle: null })).imessage.defaultHandle).toBeNull()
  })
  it('clamps presenceAwayMinutes to 1–240', () => {
    expect(mergeChannelsPut(base(), body({}, { presenceAwayMinutes: 0 })).presenceAwayMinutes).toBe(1)
    expect(mergeChannelsPut(base(), body({}, { presenceAwayMinutes: -5 })).presenceAwayMinutes).toBe(1)
    expect(mergeChannelsPut(base(), body({}, { presenceAwayMinutes: 999 })).presenceAwayMinutes).toBe(240)
    expect(mergeChannelsPut(base(), body({}, { presenceAwayMinutes: 30 })).presenceAwayMinutes).toBe(30)
  })
  it('changing defaultHandle resets defaultChatGuid; keeping it preserves the guid', () => {
    const changed = mergeChannelsPut(base(), body({ defaultHandle: 'tony@example.com' }))
    expect(changed.imessage.defaultHandle).toBe('tony@example.com')
    expect(changed.imessage.defaultChatGuid).toBeNull()
    const same = mergeChannelsPut(base(), body({ defaultHandle: '(555) 123-4567' }))
    expect(same.imessage.defaultChatGuid).toBe('iMessage;-;+15551234567')
  })
  it('never changes the webhook token', () => {
    expect(mergeChannelsPut(base(), body()).imessage.webhookToken).toBe('a'.repeat(64))
  })
  it('an empty email "to" becomes null', () => {
    expect(mergeChannelsPut(base(), body({}, { email: { enabled: true, to: '' } })).email).toEqual({ enabled: true, to: null })
  })
})
