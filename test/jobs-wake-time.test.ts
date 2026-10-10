import { describe, it, expect } from 'vitest'
import { resolveWakeWhen } from '@mymind/core/lib/agent/jobs/wake-time'

const TZ = 'America/New_York'
const NOW = new Date('2026-10-02T12:00:00Z') // 08:00 EDT

describe('resolveWakeWhen', () => {
  it('relative "in <n>m"', () => {
    const r = resolveWakeWhen('in 10m', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-02T12:10:00.000Z')
  })
  it('relative "in <n>h"', () => {
    const r = resolveWakeWhen('in 2h', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-02T14:00:00.000Z')
  })
  it('relative "in <n>d"', () => {
    const r = resolveWakeWhen('in 3d', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-05T12:00:00.000Z')
  })
  it('is case-insensitive and tolerates extra whitespace', () => {
    const r = resolveWakeWhen('IN  10M', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-02T12:10:00.000Z')
  })
  it('"today HH:MM" resolves wall-clock time in the timezone, later today', () => {
    const r = resolveWakeWhen('today 09:00', { timezone: TZ, now: NOW }) // now is 08:00 EDT
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-02T13:00:00.000Z') // 09:00 EDT
  })
  it('"today HH:MM" in the past today is rejected', () => {
    const r = resolveWakeWhen('today 07:00', { timezone: TZ, now: NOW }) // now is 08:00 EDT
    expect(r.ok).toBe(false)
  })
  it('"tomorrow HH:MM" resolves wall-clock time the next day', () => {
    const r = resolveWakeWhen('tomorrow 09:00', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-03T13:00:00.000Z') // 09:00 EDT next day
  })
  it('"tomorrow HH:MM" rolls over a month/year boundary', () => {
    const r = resolveWakeWhen('tomorrow 09:00', { timezone: TZ, now: new Date('2026-12-31T20:00:00Z') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2027-01-01T14:00:00.000Z') // 09:00 EST
  })
  it('accepts an ISO datetime WITH an explicit offset, ignoring the timezone param', () => {
    const r = resolveWakeWhen('2026-10-02T09:00:00-04:00', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-02T13:00:00.000Z')
  })
  it('accepts an offset-less ISO datetime as wall-clock time in `timezone`', () => {
    const r = resolveWakeWhen('2026-10-02T09:00:00', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.at.toISOString()).toBe('2026-10-02T13:00:00.000Z')
  })
  it('rejects a past ISO datetime', () => {
    const r = resolveWakeWhen('2020-01-01T00:00:00Z', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(false)
  })
  it('rejects garbage input', () => {
    const r = resolveWakeWhen('whenever', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(false)
  })
  it('rejects "in 0m" (not in the future)', () => {
    const r = resolveWakeWhen('in 0m', { timezone: TZ, now: NOW })
    expect(r.ok).toBe(false)
  })
})
