import { describe, it, expect } from 'vitest'
import { resolveDeliverChannels, extractImageIds } from '@mymind/core/lib/channels/deliver'
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

describe('extractImageIds', () => {
  const A = '0b6f1e0e-8a52-4b43-9d7e-1f2a3b4c5d6e'
  const B = 'A1B2C3D4-0000-4000-8000-00000000000B'
  it('pulls upload uuids out of /api/images/<uuid>/raw links, in order, deduped', () => {
    const md = `Here: ![cat](/api/images/${A}/raw) and [again](/api/images/${A}/raw)\n![dog](https://host/api/images/${B}/raw)`
    expect(extractImageIds(md)).toEqual([A, B])
  })
  it('ignores /api/i/<slug> links, non-uuid ids and other routes', () => {
    expect(extractImageIds(`![x](/api/i/abc123) ![y](/api/images/not-a-uuid/raw) ![z](/api/images/${A}) /api/images/${A}/thumb`)).toEqual([])
  })
  it('returns [] for plain text', () => expect(extractImageIds('no images here')).toEqual([]))
})
