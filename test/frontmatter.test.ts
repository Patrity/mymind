import { describe, it, expect } from 'vitest'
import { splitFrontmatter, joinFrontmatter, setFrontmatterKey } from '@mymind/core/shared/utils/frontmatter'

describe('splitFrontmatter / joinFrontmatter', () => {
  it('round-trips a simple frontmatter document', () => {
    const original = '---\ntrigger: every 30m\nenabled: true\n---\nDo the thing.\n'
    const { data, body } = splitFrontmatter(original)
    expect(data).toEqual({ trigger: 'every 30m', enabled: true })
    expect(body).toBe('Do the thing.\n')
    expect(joinFrontmatter(data, body)).toBe(original)
  })

  it('sets error and empty data on malformed YAML', () => {
    const bad = '---\nkey: [1, 2,\n---\nbody\n'
    const { data, body, error } = splitFrontmatter(bad)
    expect(error).toBeTruthy()
    expect(data).toEqual({})
    expect(body).toBe('body\n')
  })

  it('sets error when there is no frontmatter block at all', () => {
    const { error, data } = splitFrontmatter('just a plain markdown body')
    expect(error).toBeTruthy()
    expect(data).toEqual({})
  })
})

describe('setFrontmatterKey', () => {
  it('changes only the target line, byte-for-byte on every other line', () => {
    const md = [
      '---',
      'trigger: cron 30 7 * * 1-5',
      'timezone: Europe/London',
      'active_hours: 07:00-23:00',
      'thread: main',
      'context: light',
      'deliver: [app]',
      'enabled: true',
      '---',
      'Do the thing.',
      ''
    ].join('\n')

    const updated = setFrontmatterKey(md, 'enabled', false)
    const before = md.split('\n')
    const after = updated.split('\n')

    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 'enabled: true') {
        expect(after[i]).toBe('enabled: false')
      } else {
        expect(after[i]).toBe(before[i])
      }
    }
  })

  it('preserves a same-line comment on an untouched key', () => {
    const md = '---\ntrigger: every 30m # do not remove\nenabled: true\n---\nx\n'
    const updated = setFrontmatterKey(md, 'enabled', false)
    expect(updated).toBe('---\ntrigger: every 30m # do not remove\nenabled: false\n---\nx\n')
  })

  it('creates a frontmatter block when the source has none', () => {
    const updated = setFrontmatterKey('just a body', 'enabled', false)
    expect(updated).toBe('---\nenabled: false\n---\njust a body')
  })

  // Task 4 review fix round 1, item 1: the old implementation re-serialised the WHOLE frontmatter
  // block via the yaml Document API, which collapses comment padding (multiple spaces before `#`)
  // and drops flow-collection padding (`{ project: mymind }` -> `{project: mymind}`). This is the
  // spec §3 job file, verbatim byte-for-byte (copied via a script that printed each line's repr,
  // not hand-typed) — including both shapes the bug report named.
  it('is byte-stable on the spec §3 job file verbatim (comments + flow map)', () => {
    const lines = [
      '---',
      'trigger: cron 30 7 * * 1-5     # cron <expr> | every <n>m|<n>h | at <ISO datetime> | event <name>',
      'timezone: America/New_York     # IANA; default = settings `agent_timezone`, else server TZ',
      'active_hours: 07:00-23:00      # optional; ticks outside → outcome \'skipped\'',
      'model: default                 # or a registry model id',
      'thread: main                   # main | isolated',
      'context: light                 # light | full',
      'deliver: [app]                 # stored; only \'app\' is honoured until cycle 75',
      'enabled: true',
      'filter: { project: mymind }    # event jobs only; optional key/value match on the event payload',
      '---',
      'Give Tony a morning brief: what\'s due today and overdue, what changed overnight,',
      'captures waiting in triage, anything stale for 3+ days. Under 10 lines.',
      'If nothing matters, reply NO_REPLY.',
      ''
    ]
    const md = lines.join('\n')
    const updated = setFrontmatterKey(md, 'enabled', false)
    const before = md.split('\n')
    const after = updated.split('\n')

    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 'enabled: true') {
        expect(after[i]).toBe('enabled: false')
      } else {
        expect(after[i]).toBe(before[i])
      }
    }
    // Spot-check the two shapes the bug report named explicitly.
    expect(after).toContain('filter: { project: mymind }    # event jobs only; optional key/value match on the event payload')
    expect(after).toContain('deliver: [app]                 # stored; only \'app\' is honoured until cycle 75')
  })

  // Task 4 review fix round 2, item 1: FRONTMATTER_RE's `\r?` on each fence consumes the LAST
  // captured line's own trailing \r (it belongs to the closing fence's match), so a naive
  // split-on-'\n' left every EARLIER line with a trailing \r still attached. `.` never matches
  // `\r`, so `/^enabled:(.*)$/` silently failed to match a CRLF `enabled:` line that wasn't last —
  // idx came back -1, and the code fell back to the whole-document yaml reserialize, which both
  // reformats every line (the exact bug this file exists to avoid) AND converts CRLF to LF. Same
  // spec §3 fixture, CRLF line endings, with `enabled` NOT the last key (filter still is).
  it('is byte-stable AND preserves CRLF on the spec §3 job file, CRLF, key not last', () => {
    const lines = [
      '---',
      'trigger: cron 30 7 * * 1-5     # cron <expr> | every <n>m|<n>h | at <ISO datetime> | event <name>',
      'timezone: America/New_York     # IANA; default = settings `agent_timezone`, else server TZ',
      'active_hours: 07:00-23:00      # optional; ticks outside → outcome \'skipped\'',
      'model: default                 # or a registry model id',
      'thread: main                   # main | isolated',
      'context: light                 # light | full',
      'deliver: [app]                 # stored; only \'app\' is honoured until cycle 75',
      'enabled: true',
      'filter: { project: mymind }    # event jobs only; optional key/value match on the event payload',
      '---',
      'Give Tony a morning brief: what\'s due today and overdue, what changed overnight,',
      'captures waiting in triage, anything stale for 3+ days. Under 10 lines.',
      'If nothing matters, reply NO_REPLY.',
      ''
    ]
    const md = lines.join('\r\n')
    const updated = setFrontmatterKey(md, 'enabled', false)
    const before = md.split('\r\n')
    const after = updated.split('\r\n')

    // Splitting on \r\n alone must fully account for every line break — a bare \n anywhere would
    // desync this split (proving CRLF was NOT uniformly preserved).
    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 'enabled: true') {
        expect(after[i]).toBe('enabled: false')
      } else {
        expect(after[i]).toBe(before[i])
      }
    }
    // No bare LF anywhere in the output (every \n is part of a \r\n pair) — the direct "CRLF
    // preserved" assertion.
    expect(/(?<!\r)\n/.test(updated)).toBe(false)
    // These two lines only survive byte-identical if the whole-document reserialize fallback did
    // NOT run (it collapses comment padding and flow-map spacing) — the same evidence used to
    // prove the LF version above took the targeted-line path, not the fallback.
    expect(after).toContain('filter: { project: mymind }    # event jobs only; optional key/value match on the event payload')
    expect(after).toContain('deliver: [app]                 # stored; only \'app\' is honoured until cycle 75')
  })

  it('replaces a flow-collection value on the target line itself (that line MAY reformat)', () => {
    const md = '---\nfilter: { project: mymind }    # comment\nenabled: true\n---\nx\n'
    const updated = setFrontmatterKey(md, 'filter', { project: 'bridget' })
    expect(updated).toBe('---\nfilter: {project: bridget}    # comment\nenabled: true\n---\nx\n')
  })
})
