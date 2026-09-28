// test/jobs-routes.test.ts
//
// Handler tests (store mocked) for the jobs + skill-source HTTP API (cycle 74, Task 9) — same
// stubGlobal + dynamic-import harness as agent-wake-route.test.ts / conversation-leaf-route.test.ts.
// jobs/store.ts and services/skills.ts are mocked via `importOriginal` + spread so the REAL
// JOB_SLUG_RE / SKILL_NAME_RE / JobValidationError / JobNotFoundError / ConflictError keep working
// inside server/utils/agent-config-http.ts, which every route under test goes through — only the
// DB-touching functions (getJob, saveJob, saveSkillSource, ...) are replaced with vi.fn()s.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, data?: unknown }) =>
  Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)
const setResponseStatus = vi.fn()
vi.stubGlobal('setResponseStatus', setResponseStatus)

const listJobs = vi.fn()
const getJob = vi.fn()
const createJob = vi.fn()
const saveJob = vi.fn()
const setJobEnabled = vi.fn()
const deleteJob = vi.fn()
const revertJob = vi.fn()
vi.mock('../server/lib/agent/jobs/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/lib/agent/jobs/store')>()
  return { ...actual, listJobs, getJob, createJob, saveJob, setJobEnabled, deleteJob, revertJob }
})

const runJobNow = vi.fn()
vi.mock('../server/lib/agent/jobs/tick', () => ({ runJobNow }))

const listRevisions = vi.fn()
vi.mock('../server/lib/agent/config/revisions', () => ({ listRevisions }))

const listRuns = vi.fn()
vi.mock('../server/lib/agent/runtime/runs', () => ({ listRuns }))

const getSkillSource = vi.fn()
const saveSkillSource = vi.fn()
const listSkillRevisions = vi.fn()
const revertSkill = vi.fn()
vi.mock('../server/services/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/skills')>()
  return { ...actual, getSkillSource, saveSkillSource, listSkillRevisions, revertSkill }
})

const { ConflictError, JobValidationError, JobNotFoundError } = await import('../server/lib/agent/jobs/store')

const jobsIndexGet = (await import('../server/api/jobs/index.get')).default as (e: unknown) => Promise<unknown>
const jobsIndexPost = (await import('../server/api/jobs/index.post')).default as (e: unknown) => Promise<unknown>
const jobGet = (await import('../server/api/jobs/[slug].get')).default as (e: unknown) => Promise<unknown>
const jobPut = (await import('../server/api/jobs/[slug].put')).default as (e: unknown) => Promise<unknown>
const jobDelete = (await import('../server/api/jobs/[slug].delete')).default as (e: unknown) => Promise<unknown>
const jobRun = (await import('../server/api/jobs/[slug]/run.post')).default as (e: unknown) => Promise<unknown>
const jobEnabled = (await import('../server/api/jobs/[slug]/enabled.put')).default as (e: unknown) => Promise<unknown>
const jobRevisions = (await import('../server/api/jobs/[slug]/revisions.get')).default as (e: unknown) => Promise<unknown>
const jobRevert = (await import('../server/api/jobs/[slug]/revert.post')).default as (e: unknown) => Promise<unknown>

const skillSourceGet = (await import('../server/api/skills/[name]/source.get')).default as (e: unknown) => Promise<unknown>
const skillSourcePut = (await import('../server/api/skills/[name]/source.put')).default as (e: unknown) => Promise<unknown>
const skillRevisionsGet = (await import('../server/api/skills/[name]/revisions.get')).default as (e: unknown) => Promise<unknown>
const skillRevert = (await import('../server/api/skills/[name]/revert.post')).default as (e: unknown) => Promise<unknown>

function evt(opts: { params?: Record<string, string>, body?: unknown } = {}) {
  return { params: opts.params ?? {}, body: opts.body }
}

const JOB = {
  id: 'j1', slug: 'daily-digest', content: '---\ntrigger: every 10m\nenabled: true\n---\ndo the thing',
  contentHash: 'hash1', source: 'human' as const, enabled: true, triggerKind: 'every', triggerExpr: '10m',
  timezone: 'UTC', description: 'every 10 minutes', nextRunAt: null, parseError: null,
  lastRunAt: null, lastRunId: null, lastOutcome: null, consecutiveFailures: 0, updatedAt: '2026-01-01T00:00:00.000Z'
}

const SKILL_SOURCE = {
  id: 's1', slug: 'daily-brief', content: '---\nname: daily-brief\n---\nbody',
  contentHash: 'shash1', active: true, source: 'human' as const, updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => {
  listJobs.mockReset(); getJob.mockReset(); createJob.mockReset(); saveJob.mockReset()
  setJobEnabled.mockReset(); deleteJob.mockReset(); revertJob.mockReset()
  runJobNow.mockReset(); listRevisions.mockReset(); listRuns.mockReset()
  getSkillSource.mockReset(); saveSkillSource.mockReset(); listSkillRevisions.mockReset(); revertSkill.mockReset()
  setResponseStatus.mockReset()
})

// ---- GET /api/jobs -------------------------------------------------------------------------

describe('GET /api/jobs', () => {
  it('returns listJobs() unmodified', async () => {
    listJobs.mockResolvedValue([JOB])
    await expect(jobsIndexGet(evt())).resolves.toEqual([JOB])
  })
})

// ---- POST /api/jobs -------------------------------------------------------------------------

describe('POST /api/jobs', () => {
  it('creates and returns 201', async () => {
    createJob.mockResolvedValue(JOB)
    const out = await jobsIndexPost(evt({ body: { slug: 'daily-digest', content: JOB.content } }))
    expect(createJob).toHaveBeenCalledWith({ slug: 'daily-digest', content: JOB.content, actor: 'human' })
    expect(setResponseStatus).toHaveBeenCalledWith(expect.anything(), 201)
    expect(out).toEqual(JOB)
  })

  it('maps JobValidationError to 400 with the message', async () => {
    createJob.mockRejectedValue(new JobValidationError('job body must not be empty'))
    await expect(jobsIndexPost(evt({ body: { slug: 'x', content: '' } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'job body must not be empty' })
  })

  it('maps ConflictError (slug already exists) to 409 carrying current', async () => {
    createJob.mockRejectedValue(new ConflictError({ content: 'old', contentHash: 'oldhash' }))
    await expect(jobsIndexPost(evt({ body: { slug: 'daily-digest', content: 'x' } })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'old', contentHash: 'oldhash' } } })
  })

  it('rejects a malformed body with 400 before reaching createJob', async () => {
    await expect(jobsIndexPost(evt({ body: { slug: 'x' } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(createJob).not.toHaveBeenCalled()
  })
})

// ---- GET /api/jobs/:slug --------------------------------------------------------------------

describe('GET /api/jobs/:slug', () => {
  it('returns job + 5 next fire times + up to 10 mapped runs', async () => {
    getJob.mockResolvedValue(JOB)
    const claimed = new Date('2026-01-01T00:00:00.000Z')
    const finished = new Date('2026-01-01T00:00:02.500Z')
    listRuns.mockResolvedValue([{
      id: 'r1', status: 'done', suppressed: false, createdAt: claimed, claimedAt: claimed, finishedAt: finished,
      conversationId: 'c1', assistantMessageId: 'm1'
    }])

    const out = await jobGet(evt({ params: { slug: 'daily-digest' } })) as {
      job: unknown, nextFireTimes: string[], runs: { durationMs: number | null }[]
    }
    expect(listRuns).toHaveBeenCalledWith({ jobId: 'j1', limit: 10 })
    expect(out.job).toEqual(JOB)
    expect(out.nextFireTimes).toHaveLength(5)
    expect(out.runs).toEqual([{
      id: 'r1', status: 'done', suppressed: false, createdAt: claimed.toISOString(),
      durationMs: 2500, conversationId: 'c1', assistantMessageId: 'm1'
    }])
  })

  it('durationMs is null when claimedAt or finishedAt is missing', async () => {
    getJob.mockResolvedValue(JOB)
    listRuns.mockResolvedValue([{
      id: 'r2', status: 'running', suppressed: false, createdAt: new Date('2026-01-01T00:00:00.000Z'),
      claimedAt: null, finishedAt: null, conversationId: 'c1', assistantMessageId: null
    }])
    const out = await jobGet(evt({ params: { slug: 'daily-digest' } })) as { runs: { durationMs: unknown }[] }
    expect(out.runs[0]!.durationMs).toBeNull()
  })

  it('404s on a missing job', async () => {
    getJob.mockResolvedValue(null)
    await expect(jobGet(evt({ params: { slug: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s on a malformed slug before ever calling getJob', async () => {
    await expect(jobGet(evt({ params: { slug: 'Not Valid!' } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(getJob).not.toHaveBeenCalled()
  })
})

// ---- PUT /api/jobs/:slug --------------------------------------------------------------------

describe('PUT /api/jobs/:slug', () => {
  it('saves with CAS and returns the JobDTO', async () => {
    saveJob.mockResolvedValue(JOB)
    const out = await jobPut(evt({ params: { slug: 'daily-digest' }, body: { content: 'x', expectedHash: 'hash1' } }))
    expect(saveJob).toHaveBeenCalledWith('daily-digest', 'x', 'hash1', 'human')
    expect(out).toEqual(JOB)
  })

  it('409s and carries current on a CAS mismatch', async () => {
    saveJob.mockRejectedValue(new ConflictError({ content: 'their content', contentHash: 'theirhash' }))
    await expect(jobPut(evt({ params: { slug: 'daily-digest' }, body: { content: 'x', expectedHash: 'stale' } })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'their content', contentHash: 'theirhash' } } })
  })

  it('400s with the parse error message on invalid content', async () => {
    saveJob.mockRejectedValue(new JobValidationError('unknown trigger: nope'))
    await expect(jobPut(evt({ params: { slug: 'daily-digest' }, body: { content: 'bad', expectedHash: 'hash1' } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'unknown trigger: nope' })
  })

  it('404s when the job no longer exists', async () => {
    saveJob.mockRejectedValue(new JobNotFoundError('daily-digest'))
    await expect(jobPut(evt({ params: { slug: 'daily-digest' }, body: { content: 'x', expectedHash: 'hash1' } })))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s on a malformed slug before ever calling saveJob', async () => {
    await expect(jobPut(evt({ params: { slug: 'BadSlug' }, body: { content: 'x', expectedHash: null } })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(saveJob).not.toHaveBeenCalled()
  })
})

// ---- DELETE /api/jobs/:slug -----------------------------------------------------------------

describe('DELETE /api/jobs/:slug', () => {
  it('deletes and returns { deleted }', async () => {
    deleteJob.mockResolvedValue(true)
    await expect(jobDelete(evt({ params: { slug: 'daily-digest' } }))).resolves.toEqual({ deleted: 'daily-digest' })
  })

  it('404s when nothing was deleted', async () => {
    deleteJob.mockResolvedValue(false)
    await expect(jobDelete(evt({ params: { slug: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s on a malformed slug before ever calling deleteJob', async () => {
    await expect(jobDelete(evt({ params: { slug: 'Bad Slug' } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(deleteJob).not.toHaveBeenCalled()
  })
})

// ---- POST /api/jobs/:slug/run ---------------------------------------------------------------

describe('POST /api/jobs/:slug/run', () => {
  it('runs and returns runJobNow()', async () => {
    getJob.mockResolvedValue(JOB)
    runJobNow.mockResolvedValue({ runId: 'r1' })
    await expect(jobRun(evt({ params: { slug: 'daily-digest' } }))).resolves.toEqual({ runId: 'r1' })
    expect(runJobNow).toHaveBeenCalledWith('daily-digest')
  })

  it('passes through a skip result', async () => {
    getJob.mockResolvedValue(JOB)
    runJobNow.mockResolvedValue({ skipped: 'disabled' })
    await expect(jobRun(evt({ params: { slug: 'daily-digest' } }))).resolves.toEqual({ skipped: 'disabled' })
  })

  it('404s on a missing job WITHOUT calling runJobNow', async () => {
    getJob.mockResolvedValue(null)
    await expect(jobRun(evt({ params: { slug: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
    expect(runJobNow).not.toHaveBeenCalled()
  })
})

// ---- PUT /api/jobs/:slug/enabled -----------------------------------------------------------

describe('PUT /api/jobs/:slug/enabled', () => {
  it('flips enabled and returns the JobDTO', async () => {
    setJobEnabled.mockResolvedValue({ ...JOB, enabled: false })
    const out = await jobEnabled(evt({ params: { slug: 'daily-digest' }, body: { enabled: false } }))
    expect(setJobEnabled).toHaveBeenCalledWith('daily-digest', false, 'human')
    expect(out).toEqual({ ...JOB, enabled: false })
  })

  it('404s when the job does not exist', async () => {
    setJobEnabled.mockRejectedValue(new JobNotFoundError('nope'))
    await expect(jobEnabled(evt({ params: { slug: 'nope' }, body: { enabled: true } })))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s when enabling would exceed the cap', async () => {
    setJobEnabled.mockRejectedValue(new JobValidationError('at most 50 jobs may be enabled at once'))
    await expect(jobEnabled(evt({ params: { slug: 'daily-digest' }, body: { enabled: true } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'at most 50 jobs may be enabled at once' })
  })

  it('rejects a non-boolean enabled with 400 before calling setJobEnabled', async () => {
    await expect(jobEnabled(evt({ params: { slug: 'daily-digest' }, body: { enabled: 'yes' } })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(setJobEnabled).not.toHaveBeenCalled()
  })
})

// ---- GET /api/jobs/:slug/revisions -----------------------------------------------------------

describe('GET /api/jobs/:slug/revisions', () => {
  it('returns the revision list for the job id', async () => {
    getJob.mockResolvedValue(JOB)
    const revs = [{ id: 'rev1', content: 'x', actor: 'human', createdAt: '2026-01-01T00:00:00.000Z' }]
    listRevisions.mockResolvedValue(revs)
    await expect(jobRevisions(evt({ params: { slug: 'daily-digest' } }))).resolves.toEqual(revs)
    expect(listRevisions).toHaveBeenCalledWith('job', 'j1')
  })

  it('404s on a missing job', async () => {
    getJob.mockResolvedValue(null)
    await expect(jobRevisions(evt({ params: { slug: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
    expect(listRevisions).not.toHaveBeenCalled()
  })
})

// ---- POST /api/jobs/:slug/revert -------------------------------------------------------------

describe('POST /api/jobs/:slug/revert', () => {
  it('reverts and returns the JobDTO', async () => {
    getJob.mockResolvedValue(JOB)
    revertJob.mockResolvedValue(JOB)
    const out = await jobRevert(evt({ params: { slug: 'daily-digest' }, body: { revisionId: 'rev1' } }))
    expect(revertJob).toHaveBeenCalledWith('daily-digest', 'rev1', 'human')
    expect(out).toEqual(JOB)
  })

  it('404s on a missing job WITHOUT calling revertJob', async () => {
    getJob.mockResolvedValue(null)
    await expect(jobRevert(evt({ params: { slug: 'nope' }, body: { revisionId: 'rev1' } })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(revertJob).not.toHaveBeenCalled()
  })

  it('409s and carries current when the job changed since it was read', async () => {
    getJob.mockResolvedValue(JOB)
    revertJob.mockRejectedValue(new ConflictError({ content: 'their content', contentHash: 'theirhash' }))
    await expect(jobRevert(evt({ params: { slug: 'daily-digest' }, body: { revisionId: 'rev1' } })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'their content', contentHash: 'theirhash' } } })
  })

  it('400s when the revision does not belong to this job (a plain Error, not a class)', async () => {
    getJob.mockResolvedValue(JOB)
    revertJob.mockRejectedValue(new Error('revision rev9 does not belong to job "daily-digest"'))
    await expect(jobRevert(evt({ params: { slug: 'daily-digest' }, body: { revisionId: 'rev9' } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'revision rev9 does not belong to job "daily-digest"' })
  })
})

// ---- GET /api/skills/:name/source -------------------------------------------------------------

describe('GET /api/skills/:name/source', () => {
  it('returns the skill source', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    await expect(skillSourceGet(evt({ params: { name: 'daily-brief' } }))).resolves.toEqual(SKILL_SOURCE)
  })

  it('404s on a missing skill', async () => {
    getSkillSource.mockResolvedValue(null)
    await expect(skillSourceGet(evt({ params: { name: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s on a malformed name before ever calling getSkillSource', async () => {
    await expect(skillSourceGet(evt({ params: { name: 'Bad_Name' } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(getSkillSource).not.toHaveBeenCalled()
  })
})

// ---- PUT /api/skills/:name/source -------------------------------------------------------------

describe('PUT /api/skills/:name/source', () => {
  it('creates when expectedHash is null', async () => {
    saveSkillSource.mockResolvedValue(SKILL_SOURCE)
    const out = await skillSourcePut(evt({ params: { name: 'daily-brief' }, body: { content: 'x', expectedHash: null } }))
    expect(getSkillSource).not.toHaveBeenCalled() // create path skips the pre-existence check
    expect(saveSkillSource).toHaveBeenCalledWith('daily-brief', 'x', null, 'human')
    expect(out).toEqual(SKILL_SOURCE)
  })

  it('saves with CAS when expectedHash is set', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    saveSkillSource.mockResolvedValue(SKILL_SOURCE)
    const out = await skillSourcePut(evt({ params: { name: 'daily-brief' }, body: { content: 'x', expectedHash: 'shash1' } }))
    expect(saveSkillSource).toHaveBeenCalledWith('daily-brief', 'x', 'shash1', 'human')
    expect(out).toEqual(SKILL_SOURCE)
  })

  it('409s and carries current on a CAS mismatch', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    saveSkillSource.mockRejectedValue(new ConflictError({ content: 'their content', contentHash: 'theirhash' }))
    await expect(skillSourcePut(evt({ params: { name: 'daily-brief' }, body: { content: 'x', expectedHash: 'stale' } })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'their content', contentHash: 'theirhash' } } })
  })

  it('400s with the validation message on bad frontmatter', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    saveSkillSource.mockRejectedValue(new Error('description is required'))
    await expect(skillSourcePut(evt({ params: { name: 'daily-brief' }, body: { content: 'bad', expectedHash: 'shash1' } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'description is required' })
  })

  it('404s updating a skill that no longer exists, WITHOUT calling saveSkillSource', async () => {
    getSkillSource.mockResolvedValue(null)
    await expect(skillSourcePut(evt({ params: { name: 'nope' }, body: { content: 'x', expectedHash: 'shash1' } })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(saveSkillSource).not.toHaveBeenCalled()
  })

  it('400s on a malformed name before ever calling saveSkillSource', async () => {
    await expect(skillSourcePut(evt({ params: { name: 'Bad Name' }, body: { content: 'x', expectedHash: null } })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(saveSkillSource).not.toHaveBeenCalled()
  })
})

// ---- GET /api/skills/:name/revisions -----------------------------------------------------------

describe('GET /api/skills/:name/revisions', () => {
  it('returns the revision list', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    const revs = [{ id: 'rev1', content: 'x', actor: 'human', createdAt: '2026-01-01T00:00:00.000Z' }]
    listSkillRevisions.mockResolvedValue(revs)
    await expect(skillRevisionsGet(evt({ params: { name: 'daily-brief' } }))).resolves.toEqual(revs)
    expect(listSkillRevisions).toHaveBeenCalledWith('daily-brief')
  })

  it('404s on a missing skill', async () => {
    getSkillSource.mockResolvedValue(null)
    await expect(skillRevisionsGet(evt({ params: { name: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
    expect(listSkillRevisions).not.toHaveBeenCalled()
  })
})

// ---- POST /api/skills/:name/revert -------------------------------------------------------------

describe('POST /api/skills/:name/revert', () => {
  it('reverts and returns the skill source', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    revertSkill.mockResolvedValue(SKILL_SOURCE)
    const out = await skillRevert(evt({ params: { name: 'daily-brief' }, body: { revisionId: 'rev1' } }))
    expect(revertSkill).toHaveBeenCalledWith('daily-brief', 'rev1', 'human')
    expect(out).toEqual(SKILL_SOURCE)
  })

  it('404s on a missing skill WITHOUT calling revertSkill', async () => {
    getSkillSource.mockResolvedValue(null)
    await expect(skillRevert(evt({ params: { name: 'nope' }, body: { revisionId: 'rev1' } })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(revertSkill).not.toHaveBeenCalled()
  })

  it('409s and carries current when the skill changed since it was read', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    revertSkill.mockRejectedValue(new ConflictError({ content: 'their content', contentHash: 'theirhash' }))
    await expect(skillRevert(evt({ params: { name: 'daily-brief' }, body: { revisionId: 'rev1' } })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'their content', contentHash: 'theirhash' } } })
  })

  it('400s when the revision does not belong to this skill (a plain Error, not a class)', async () => {
    getSkillSource.mockResolvedValue(SKILL_SOURCE)
    revertSkill.mockRejectedValue(new Error('revision rev9 does not belong to skill "daily-brief"'))
    await expect(skillRevert(evt({ params: { name: 'daily-brief' }, body: { revisionId: 'rev9' } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'revision rev9 does not belong to skill "daily-brief"' })
  })
})
