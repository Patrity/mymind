process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { useDb } from '../server/db'
import { agentSkills, agentJobs, agentJobFires } from '../server/db/schema'
import { inArray } from 'drizzle-orm'

const violates = (name: string) => (e: unknown) => {
  const err = e as { message?: string; cause?: { message?: string } }
  return new RegExp(name).test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`)
}
const skillIds: string[] = []; const jobIds: string[] = []
afterAll(async () => {
  const db = useDb()
  if (jobIds.length) await db.delete(agentJobs).where(inArray(agentJobs.id, jobIds))
  if (skillIds.length) await db.delete(agentSkills).where(inArray(agentSkills.id, skillIds))
})

describe('agent config schema', () => {
  it('skill and job slugs are unique', async () => {
    const [s] = await useDb().insert(agentSkills).values({ slug: 'schema-test-skill', content: 'x', contentHash: 'h' }).returning()
    skillIds.push(s!.id)
    await expect(useDb().insert(agentSkills).values({ slug: 'schema-test-skill', content: 'y', contentHash: 'h2' })).rejects.toSatisfy(violates('agent_skills_slug'))
    const [j] = await useDb().insert(agentJobs).values({ slug: 'schema-test-job', content: 'x', contentHash: 'h' }).returning()
    jobIds.push(j!.id)
    expect(j!.enabled).toBe(false)
    expect(j!.consecutiveFailures).toBe(0)
  })
  it('an event fire is recorded once per (job, key)', async () => {
    const [j] = await useDb().insert(agentJobs).values({ slug: 'schema-test-fires', content: 'x', contentHash: 'h' }).returning()
    jobIds.push(j!.id)
    await useDb().insert(agentJobFires).values({ jobId: j!.id, eventKey: 'k1' })
    await expect(useDb().insert(agentJobFires).values({ jobId: j!.id, eventKey: 'k1' })).rejects.toSatisfy(violates('agent_job_fires_pkey'))
  })
})
