import { describe, it, expect } from 'vitest'
import { classifySaveError, configEndpoints, reconcileSnapshot, skillStarterMarkdown, toSnapshot } from './source'
import { splitFrontmatter } from '~~/shared/utils/frontmatter'

describe('reconcileSnapshot', () => {
  const snap = { content: 'x', contentHash: 'h2' }

  it('adopts the first load', () => {
    expect(reconcileSnapshot(snap, { savedHash: null, dirty: false })).toBe('adopt')
  })

  it('ignores the version we already hold, dirty or not', () => {
    expect(reconcileSnapshot({ content: 'x', contentHash: 'h1' }, { savedHash: 'h1', dirty: false })).toBe('ignore')
    expect(reconcileSnapshot({ content: 'x', contentHash: 'h1' }, { savedHash: 'h1', dirty: true })).toBe('ignore')
  })

  it('adopts an outside change when there are no local edits', () => {
    expect(reconcileSnapshot(snap, { savedHash: 'h1', dirty: false })).toBe('adopt')
  })

  it('flags an outside change instead of clobbering local edits', () => {
    expect(reconcileSnapshot(snap, { savedHash: 'h1', dirty: true })).toBe('flag')
  })
})

describe('classifySaveError', () => {
  it('reads the conflict copy from the nested H3 error body', () => {
    const err = { status: 409, data: { statusMessage: 'changed', data: { current: { content: 'theirs', contentHash: 'hT' } } } }
    expect(classifySaveError(err)).toEqual({ kind: 'conflict', current: { content: 'theirs', contentHash: 'hT' } })
  })

  it('also accepts a flat data.current', () => {
    const err = { statusCode: 409, data: { current: { content: 'c', contentHash: 'h' } } }
    expect(classifySaveError(err)).toEqual({ kind: 'conflict', current: { content: 'c', contentHash: 'h' } })
  })

  it('a 409 without a current copy is a plain error', () => {
    expect(classifySaveError({ status: 409, data: { statusMessage: 'nope' } })).toEqual({ kind: 'error', message: 'nope' })
  })

  it('maps a 400 to an inline validation message', () => {
    const err = { status: 400, message: '[PUT] "/x": 400 bad', data: { statusMessage: 'frontmatter name "x" must match the skill "y"' } }
    expect(classifySaveError(err)).toEqual({ kind: 'invalid', message: 'frontmatter name "x" must match the skill "y"' })
  })

  it('anything else is a generic error with the best message available', () => {
    expect(classifySaveError({ status: 500, message: 'boom' })).toEqual({ kind: 'error', message: 'boom' })
    expect(classifySaveError(new Error('offline'))).toEqual({ kind: 'error', message: 'offline' })
  })
})

describe('toSnapshot', () => {
  it('unwraps the jobs GET envelope', () => {
    expect(toSnapshot({ job: { content: 'j', contentHash: 'hj', slug: 's' }, runs: [] })).toEqual({ content: 'j', contentHash: 'hj' })
  })
  it('passes a flat DTO through', () => {
    expect(toSnapshot({ content: 's', contentHash: 'hs', active: true })).toEqual({ content: 's', contentHash: 'hs' })
  })
})

describe('configEndpoints', () => {
  it('keys skills under the live-invalidated ["skills"] base and jobs under ["jobs"]', () => {
    expect(configEndpoints('skill', 'a-b')).toMatchObject({ queryBase: 'skills', source: '/api/skills/a-b/source', save: '/api/skills/a-b/source' })
    expect(configEndpoints('job', 'a-b')).toMatchObject({ queryBase: 'jobs', source: '/api/jobs/a-b', save: '/api/jobs/a-b', revert: '/api/jobs/a-b/revert' })
  })
})

describe('skillStarterMarkdown', () => {
  it('produces frontmatter naming the skill with every required field filled', () => {
    const { data, body, error } = splitFrontmatter(skillStarterMarkdown('my-skill'))
    expect(error).toBeUndefined()
    expect(data).toMatchObject({ name: 'my-skill', active: true, source: 'human' })
    expect(String(data.description).trim()).not.toBe('')
    expect(String(data.when_to_use).trim()).not.toBe('')
    expect(body.trim()).not.toBe('')
  })
})
