// DB-backed — harness pattern from test/jobs-store.db.test.ts
//
// Cycle 75, Task 8: upgradeSeedJobs moves an UNEDITED seed from its previous content to the
// current one, hash-guarded. The real four seeds live on the shared dev DB and must never be
// touched here: every call passes the seam (`seeds` / `previous` / `onlySlugs`) with fake slugs
// prefixed `jseedtest-`, and the real seeds' content hashes are compared before and after.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentJobs, agentConfigRevisions } from '../server/db/schema'
import { listRevisions } from '../server/lib/agent/config/revisions'
import { SEED_JOB_SLUGS, SEED_JOBS, SEED_JOBS_V1 } from '../server/lib/agent/jobs/seeds'
import { createJob, saveJob, getJob, setJobEnabled, upgradeSeedJobs } from '../server/lib/agent/jobs/store'
import { setFrontmatterKey } from '../shared/utils/frontmatter'

const PREFIX = 'jseedtest-'
const md = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`

async function cleanup() {
  const db = useDb()
  const rows = await db.select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`))
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
  await db.delete(agentJobs).where(inArray(agentJobs.id, ids))
}

async function realSeedHashes(): Promise<Record<string, string>> {
  const rows = await useDb().select({ slug: agentJobs.slug, hash: agentJobs.contentHash }).from(agentJobs)
    .where(inArray(agentJobs.slug, [...SEED_JOB_SLUGS]))
  return Object.fromEntries(rows.map(r => [r.slug, r.hash]))
}

let realBefore: Record<string, string> = {}
beforeAll(async () => {
  await cleanup()
  realBefore = await realSeedHashes()
})
afterAll(cleanup)

describe('seed content', () => {
  it('each current seed is its V1 content plus exactly one `deliver:` line', () => {
    for (const slug of SEED_JOB_SLUGS) {
      expect(SEED_JOBS_V1[slug]).not.toMatch(/^deliver:/m)
      expect(SEED_JOBS[slug].replace(/^deliver: .*\n/m, '')).toBe(SEED_JOBS_V1[slug])
    }
    expect(SEED_JOBS['morning-brief']).toMatch(/^deliver: \[auto, imessage\]$/m)
    expect(SEED_JOBS['evening-wrap']).toMatch(/^deliver: \[auto\]$/m)
    expect(SEED_JOBS.heartbeat).toMatch(/^deliver: \[auto\]$/m)
    expect(SEED_JOBS['session-digest']).toMatch(/^deliver: \[app\]$/m)
    for (const slug of SEED_JOB_SLUGS) expect(SEED_JOBS[slug]).toMatch(/^enabled: false$/m)
  })

  it('switching a seed on changes only its enabled line, in both versions', () => {
    for (const slug of SEED_JOB_SLUGS) {
      const onV1 = setFrontmatterKey(SEED_JOBS_V1[slug], 'enabled', true)
      expect(onV1).toBe(SEED_JOBS_V1[slug].replace(/^enabled: false$/m, 'enabled: true'))
      expect(setFrontmatterKey(SEED_JOBS[slug], 'enabled', true).replace(/^deliver: .*\n/m, '')).toBe(onV1)
    }
  })
})

describe('upgradeSeedJobs (scoped fake slugs)', () => {
  const v1 = (n: string) => md('trigger: every 30m\nenabled: false', `Seed ${n}.`)
  const v2 = (n: string) => md('trigger: every 30m\ndeliver: [auto]\nenabled: false', `Seed ${n}.`)
  const plain = `${PREFIX}plain`
  const edited = `${PREFIX}edited`
  const missing = `${PREFIX}missing`
  const seeds = { [plain]: v2('a'), [edited]: v2('b'), [missing]: v2('c') }
  const previous = { [plain]: v1('a'), [edited]: v1('b'), [missing]: v1('c') }
  const onlySlugs = [plain, edited, missing]

  it('upgrades an unedited seed, leaves an edited one alone, and a second run is a no-op', async () => {
    const a = await createJob({ slug: plain, content: v1('a'), actor: 'system' })
    const b = await createJob({ slug: edited, content: v1('b'), actor: 'system' })
    const bEdited = await saveJob(edited, md('trigger: every 30m\nenabled: false', 'Seed b, my way.'), b.contentHash, 'human')

    expect(await upgradeSeedJobs({ seeds, previous, onlySlugs })).toBe(1)

    const aAfter = (await getJob(plain))!
    expect(aAfter.content).toBe(v2('a'))
    expect(aAfter.id).toBe(a.id)
    expect(aAfter.enabled).toBe(false)
    const revs = await listRevisions('job', a.id)
    expect(revs).toHaveLength(2)
    expect(revs.map(r => r.actor)).toEqual(['system', 'system'])

    const bAfter = (await getJob(edited))!
    expect(bAfter.contentHash).toBe(bEdited.contentHash)
    expect(await getJob(missing)).toBeNull() // never installs, only upgrades

    expect(await upgradeSeedJobs({ seeds, previous, onlySlugs })).toBe(0)
    expect((await getJob(plain))!.contentHash).toBe(aAfter.contentHash)
    expect(await listRevisions('job', a.id)).toHaveLength(2)
  })

  it('an unedited seed that was only switched on is upgraded and stays enabled; an enabled AND edited one is left alone', async () => {
    // A yearly trigger: an enabled test job must never come due for a live worker.
    const y1 = (n: string) => md('trigger: cron 0 0 1 1 *\nenabled: false', `Yearly ${n}.`)
    const y2 = (n: string) => md('trigger: cron 0 0 1 1 *\ndeliver: [app]\nenabled: false', `Yearly ${n}.`)
    const on = `${PREFIX}on`
    const onEdited = `${PREFIX}on-edited`
    const s = { [on]: y2('a'), [onEdited]: y2('b') }
    const p = { [on]: y1('a'), [onEdited]: y1('b') }
    await createJob({ slug: on, content: y1('a'), actor: 'system' })
    const enabled = await setJobEnabled(on, true, 'human') // exactly what the /jobs switch writes
    expect(enabled.content).toBe(setFrontmatterKey(y1('a'), 'enabled', true))
    await createJob({ slug: onEdited, content: md('trigger: cron 0 0 1 1 *\nenabled: true', 'Yearly b, mine.'), actor: 'human' })
    const editedBefore = (await getJob(onEdited))!

    expect(await upgradeSeedJobs({ seeds: s, previous: p, onlySlugs: [on, onEdited] })).toBe(1)
    const after = (await getJob(on))!
    expect(after.content).toBe(setFrontmatterKey(y2('a'), 'enabled', true))
    expect(after.content).toMatch(/^deliver: \[app\]$/m)
    expect(after.enabled).toBe(true)
    expect((await getJob(onEdited))!.contentHash).toBe(editedBefore.contentHash)

    expect(await upgradeSeedJobs({ seeds: s, previous: p, onlySlugs: [on, onEdited] })).toBe(0)
  })

  it('never touched the real seed jobs on the dev DB', async () => {
    expect(await realSeedHashes()).toEqual(realBefore)
  })
})
