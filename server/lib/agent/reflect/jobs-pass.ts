// server/lib/agent/reflect/jobs-pass.ts
//
// The nightly jobs pass (spec §4.2): close the observation windows that ended (→ `ignored`), then
// show the reflector every enabled job with at least 5 signals in the last 14 days — its file,
// signal counts by kind and up to 5 detail snippets — in ONE call, and route each proposal
// through processProposal. A proposal's evidence is checked against ITS job's snippets and file
// only, never the other jobs' (Task 5/7 ruling: signal snippets plus the job content).
import { and, desc, gte, inArray, isNotNull } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentSignals } from '../../../db/schema'
import type { chat } from '../../ai/chat'
import { listJobs } from '../jobs/store'
import { closeObservations } from '../signals/write'
import { getSelfImprovementMode } from '../self-improvement-mode'
import { jobsReflectionMessages } from './prompt'
import { callReflector } from './call'
import { processProposal } from './apply'
import type { jevCheck } from './jev'
import type { Proposal } from './schema'

export const JOBS_SIGNAL_WINDOW_MS = 14 * 24 * 3600_000
export const JOBS_MIN_SIGNALS = 5
export const JOBS_SNIPPETS = 5

const JOB_KINDS: Proposal['kind'][] = ['job.edit', 'job.disable']

interface JobInput {
  id: string
  slug: string
  content: string
  contentHash: string
  source: string
  signals: Record<string, number>
  snippets: string[]
  runIds: string[]
}

export async function runJobsPass(
  opts: { now?: Date; onlyJobSlugs?: string[]; chatFn?: typeof chat; jev?: typeof jevCheck } = {}
): Promise<{ jobs: number; proposals: number }> {
  if (await getSelfImprovementMode() === 'off') return { jobs: 0, proposals: 0 }
  const now = opts.now ?? new Date()
  const enabled = (await listJobs()).filter(j => j.enabled && (!opts.onlyJobSlugs || opts.onlyJobSlugs.includes(j.slug)))

  // Test seam: scoped to the selected jobs (the dev DB is shared with real job messages).
  await closeObservations(now, opts.onlyJobSlugs ? { onlyJobIds: enabled.map(j => j.id) } : {})
  if (!enabled.length) return { jobs: 0, proposals: 0 }

  const rows = await useDb().select({
    jobId: agentSignals.jobId, runId: agentSignals.runId, kind: agentSignals.kind, detail: agentSignals.detail
  }).from(agentSignals).where(and(
    inArray(agentSignals.jobId, enabled.map(j => j.id)),
    gte(agentSignals.createdAt, new Date(now.getTime() - JOBS_SIGNAL_WINDOW_MS)),
    isNotNull(agentSignals.jobId)
  )).orderBy(desc(agentSignals.createdAt))

  const inputs: JobInput[] = []
  for (const j of enabled) {
    const mine = rows.filter(r => r.jobId === j.id)
    if (mine.length < JOBS_MIN_SIGNALS) continue
    const signals: Record<string, number> = {}
    for (const r of mine) signals[r.kind] = (signals[r.kind] ?? 0) + 1
    inputs.push({
      id: j.id, slug: j.slug, content: j.content, contentHash: j.contentHash, source: j.source, signals,
      snippets: mine.map(r => r.detail?.trim()).filter((d): d is string => !!d).slice(0, JOBS_SNIPPETS),
      runIds: [...new Set(mine.map(r => r.runId).filter((id): id is string => !!id))]
    })
  }
  if (!inputs.length) return { jobs: 0, proposals: 0 }

  const res = await callReflector(jobsReflectionMessages({ jobs: inputs }), JOB_KINDS, { chatFn: opts.chatFn })
  if (!res.ok) {
    console.warn(`[reflect] jobs pass: ${res.error} — no proposals`)
    return { jobs: inputs.length, proposals: 0 }
  }

  for (const p of res.proposals) {
    const job = inputs.find(j => j.slug === p.target)
    try {
      await processProposal(p, {
        pass: 'jobs',
        conversationId: null,
        runIds: job?.runIds ?? [],
        // A proposal for a job the pass didn't show has no evidence source, so its quotes can't match.
        input: job ? [...job.snippets, job.content].join('\n') : '',
        expectedHash: job?.contentHash ?? null
      }, { jev: opts.jev })
    } catch (err) {
      console.warn(`[reflect] jobs pass: proposal ${p.kind} ${p.target} failed:`, err)
    }
  }
  return { jobs: inputs.length, proposals: res.proposals.length }
}
