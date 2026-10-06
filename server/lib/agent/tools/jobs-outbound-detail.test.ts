// 79b fix round 1 (M1): edit_job's tainted-run card shows the job as it would be saved.
import { describe, it, expect, vi } from 'vitest'

const STORED = '---\ntrigger: every 1d\ndeliver: none\n---\nsummarise my inbox'
vi.mock('../jobs/store', () => ({
  getJob: vi.fn(async (slug: string) => slug === 'daily' ? { slug, content: STORED } : null),
  listJobs: vi.fn(), createJob: vi.fn(), saveJob: vi.fn(), deleteJob: vi.fn(), restoreJob: vi.fn(), getDefaultTimezone: vi.fn(),
  JobValidationError: class extends Error {}, JobNotFoundError: class extends Error {}, ConflictError: class extends Error {}
}))

import { jobTools } from './jobs'

const editJob = jobTools.find(t => t.name === 'edit_job')!
const runJob = jobTools.find(t => t.name === 'run_job')!

describe('job outboundDetail', () => {
  it('edit_job find/replace → the post-edit markdown', async () => {
    const d = await editJob.outboundDetail!({ slug: 'daily', old_string: 'deliver: none', new_string: 'deliver: imessage' })
    expect(d).toContain('Job after this edit:')
    expect(d).toContain('deliver: imessage')
    expect(d).not.toContain('deliver: none')
  })
  it('edit_job with a failing replace says so', async () => {
    expect(await editJob.outboundDetail!({ slug: 'daily', old_string: 'nope', new_string: 'x' })).toMatch(/would fail: no_match/)
  })
  it('edit_job with full content adds nothing (content is already on the card); unknown job → nothing', async () => {
    expect(await editJob.outboundDetail!({ slug: 'daily', content: 'x' })).toBeUndefined()
    expect(await editJob.outboundDetail!({ slug: 'gone', old_string: 'a', new_string: 'b' })).toBeUndefined()
  })
  it('run_job → the stored markdown', async () => {
    expect(await runJob.outboundDetail!({ slug: 'daily' })).toBe(STORED)
  })
})
