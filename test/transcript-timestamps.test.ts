import { describe, it, expect } from 'vitest'
import { parseTranscriptLines } from '../server/services/transcript-parse'

// ---------------------------------------------------------------------------
// messages.created_at used to be insert time, always. Normal hook ingest runs
// seconds behind the message so nobody noticed — until the 2026-09-12 backfill
// replayed a month of history and stamped 53,047 messages "today", dragging
// started_at / last_active with them (both are min/max(created_at)).
//
// CC JSONL carries the real time on every line. Use it.
// ---------------------------------------------------------------------------

const withTs = JSON.stringify({
  uuid: 'ts1',
  timestamp: '2026-09-01T16:43:26.233Z',
  message: { role: 'user', content: 'hello from september' }
})

const withTsAssistant = JSON.stringify({
  uuid: 'ts2',
  timestamp: '2026-09-01T16:43:31.461Z',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tuTs', name: 'Bash', input: { command: 'ls' } }]
  }
})

const noTs = JSON.stringify({
  uuid: 'ts3',
  message: { role: 'user', content: 'no timestamp here' }
})

const badTs = JSON.stringify({
  uuid: 'ts4',
  timestamp: 'not-a-date',
  message: { role: 'user', content: 'bad timestamp' }
})

describe('transcript timestamps', () => {
  it('carries the line timestamp onto the message', () => {
    const r = parseTranscriptLines([withTs])
    expect(r.messages[0]!.createdAt).toBe('2026-09-01T16:43:26.233Z')
  })

  it('is a string, not a Date — stripNul/clampStrings would flatten a Date to {}', () => {
    const r = parseTranscriptLines([withTs])
    expect(typeof r.messages[0]!.createdAt).toBe('string')
  })

  it('normalises to an ISO instant Postgres will accept', () => {
    const r = parseTranscriptLines([withTs])
    expect(Number.isNaN(Date.parse(r.messages[0]!.createdAt!))).toBe(false)
  })

  it('carries the timestamp onto tool events too', () => {
    const r = parseTranscriptLines([withTsAssistant])
    expect(r.toolEvents[0]!.createdAt).toBe('2026-09-01T16:43:31.461Z')
  })

  it('is null when the line has no timestamp (so the DB default stands)', () => {
    const r = parseTranscriptLines([noTs])
    expect(r.messages[0]!.createdAt).toBeNull()
  })

  it('is null when the timestamp is unparseable', () => {
    const r = parseTranscriptLines([badTs])
    expect(r.messages[0]!.createdAt).toBeNull()
  })

  it('survives the NUL/clamp scrub intact', () => {
    // stripNul and clampStrings both rebuild objects field by field; a regression
    // there would silently drop or mangle this value.
    const r = parseTranscriptLines([withTs, withTsAssistant])
    expect(r.messages.every(m => m.createdAt === null || typeof m.createdAt === 'string')).toBe(true)
    expect(r.toolEvents[0]!.createdAt).toBe('2026-09-01T16:43:31.461Z')
  })
})
