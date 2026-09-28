import { describe, it, expect } from 'vitest'
import { normaliseHandle, isAllowed, isSendersDirectChat, maskHandle } from '../server/lib/channels/handles'

describe('normaliseHandle', () => {
  it.each([
    ['(555) 123-4567', '+15551234567'],
    ['555.123.4567', '+15551234567'],
    ['1 555 123 4567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['Tony@Example.COM ', 'tony@example.com'],
    ['mailto:tony@example.com', 'tony@example.com'],
    ['tel:+15551234567', '+15551234567']
  ])('%s → %s', (raw, want) => expect(normaliseHandle(raw)).toBe(want))
})
describe('isAllowed', () => {
  it('matches after normalising both sides', () => {
    expect(isAllowed('+1 (555) 123-4567', ['5551234567'])).toBe(true)
    expect(isAllowed('+15559999999', ['5551234567'])).toBe(false)
    expect(isAllowed('', ['5551234567'])).toBe(false)
  })
})
describe('maskHandle', () => {
  it('keeps the last 4 of a phone, the first letter + domain of an email', () => {
    expect(maskHandle('+15551234567')).toBe('+•••••••4567')
    expect(maskHandle('tony@example.com')).toBe('t•••@example.com')
  })
})
describe('isSendersDirectChat (final review I2)', () => {
  it('true for the sender\'s own direct chat, any service prefix, after normalising', () => {
    expect(isSendersDirectChat('iMessage;-;+15551234567', '+15551234567')).toBe(true)
    expect(isSendersDirectChat('SMS;-;+15551234567', '+1 (555) 123-4567')).toBe(true)
    expect(isSendersDirectChat('any;-;5551234567', '+15551234567')).toBe(true)
    expect(isSendersDirectChat('iMessage;-;Tony@Example.com', 'tony@example.com')).toBe(true)
  })
  it('false for someone else\'s chat, a group chat, a malformed guid or an empty sender', () => {
    expect(isSendersDirectChat('iMessage;-;+15550000000', '+15551234567')).toBe(false)
    expect(isSendersDirectChat('iMessage;+;chat123', '+15551234567')).toBe(false)
    expect(isSendersDirectChat('+15551234567', '+15551234567')).toBe(false)
    expect(isSendersDirectChat('iMessage;-;+15551234567', '')).toBe(false)
  })
})
