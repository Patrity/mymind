import { describe, it, expect } from 'vitest'
import { resolveDeliverChannels } from '../server/lib/channels/deliver'
const on = { imessageEnabled: true, emailEnabled: true }
describe('resolveDeliverChannels', () => {
  it('app alone delivers nowhere extra', () => expect(resolveDeliverChannels(['app'], { ...on, away: true })).toEqual([]))
  it('auto → imessage only when away', () => {
    expect(resolveDeliverChannels(['auto'], { ...on, away: true })).toEqual(['imessage'])
    expect(resolveDeliverChannels(['auto'], { ...on, away: false })).toEqual([])
  })
  it('auto never implies email', () => expect(resolveDeliverChannels(['auto'], { ...on, away: true })).not.toContain('email'))
  it('explicit channels always, deduped, stable order imessage then email', () =>
    expect(resolveDeliverChannels(['email', 'auto', 'imessage'], { ...on, away: true })).toEqual(['imessage', 'email']))
  it('a disabled channel is skipped', () =>
    expect(resolveDeliverChannels(['imessage', 'email'], { imessageEnabled: false, emailEnabled: true, away: true })).toEqual(['email']))
})
