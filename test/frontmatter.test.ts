import { describe, it, expect } from 'vitest'
import { splitFrontmatter, joinFrontmatter, setFrontmatterKey } from '../shared/utils/frontmatter'

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
})
