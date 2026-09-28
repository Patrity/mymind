import { describe, expect, it } from 'vitest'
import { deliverLabel } from './deliver-label'

describe('deliverLabel', () => {
  it('auto reads as "when you\'re away", since messages only interrupt iMessage while Tony is out', () => {
    expect(deliverLabel(['auto'])).toBe("App · iMessage when you're away")
  })

  it('an explicit imessage alongside auto wins — no "when away" hedge once iMessage always fires', () => {
    expect(deliverLabel(['auto', 'imessage'])).toBe('App · iMessage')
  })

  it('app alone reads as "App only"', () => {
    expect(deliverLabel(['app'])).toBe('App only')
  })

  it('email is listed alongside App', () => {
    expect(deliverLabel(['email'])).toBe('App · Email')
  })

  it('app always appears even when deliver never spells it out, because messages land in main regardless', () => {
    expect(deliverLabel(['imessage'])).toBe('App · iMessage')
  })

  it('combines iMessage and Email when both are configured', () => {
    expect(deliverLabel(['auto', 'email'])).toBe("App · iMessage when you're away · Email")
  })
})
