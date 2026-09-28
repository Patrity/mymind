// Cycle 75, Task 11: delivery status → the badge under an assistant bubble in /agent.
import { describe, it, expect } from 'vitest'
import { deliveryBadge, summarizeDeliveries } from '../app/lib/channels/delivery-badge'

describe('deliveryBadge', () => {
  it.each([
    ['sent', 'sent', 'success'],
    ['sent_unconfirmed', 'sent (unconfirmed)', 'neutral'],
    ['pending', 'sending', 'neutral'],
    ['sending', 'sending', 'neutral'],
    ['failed', 'failed', 'error']
  ] as const)('%s → "%s" (%s)', (status, label, color) => {
    expect(deliveryBadge({ channel: 'imessage', status })).toEqual({ icon: 'i-lucide-smartphone', label, color })
  })

  it('uses the mail icon for email', () => {
    expect(deliveryBadge({ channel: 'email', status: 'sent' })).toEqual({ icon: 'i-lucide-mail', label: 'sent', color: 'success' })
  })

  it('shows an unknown status verbatim as a warning', () => {
    expect(deliveryBadge({ channel: 'email', status: 'weird' })).toEqual({ icon: 'i-lucide-mail', label: 'weird', color: 'warning' })
  })
})

describe('summarizeDeliveries', () => {
  it('collapses split iMessage rows to the least-finished status, one entry per channel', () => {
    expect(summarizeDeliveries([
      { channel: 'email', status: 'sent' },
      { channel: 'imessage', status: 'sent' },
      { channel: 'imessage', status: 'pending' },
      { channel: 'imessage', status: 'sent_unconfirmed' }
    ])).toEqual([{ channel: 'imessage', status: 'pending' }, { channel: 'email', status: 'sent' }])
  })

  it('a failure outranks everything', () => {
    expect(summarizeDeliveries([
      { channel: 'imessage', status: 'sending' },
      { channel: 'imessage', status: 'failed' },
      { channel: 'imessage', status: 'sent' }
    ])).toEqual([{ channel: 'imessage', status: 'failed' }])
  })

  it('all sent stays sent; empty stays empty', () => {
    expect(summarizeDeliveries([{ channel: 'imessage', status: 'sent' }, { channel: 'imessage', status: 'sent' }]))
      .toEqual([{ channel: 'imessage', status: 'sent' }])
    expect(summarizeDeliveries([])).toEqual([])
  })
})
